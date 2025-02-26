-- LiveLink MPV Script
-- Features:
-- - Auto queue management
-- - Stream status tracking
-- - Watched stream tracking
-- - Multi-screen support
-- - Stream info display
-- - Auto-refresh capability

local utils = require 'mp.utils'
local msg = require 'mp.msg'

-- Configuration
local API_URL = "http://localhost:3001/api"
local current_screen = nil
local current_url = nil
local info_display_time = 10 -- How long to show info overlay (seconds)
local REFRESH_INTERVAL = 30 * 60 -- 30 minutes in seconds
local last_refresh_time = os.time()
local MIN_WATCH_TIME = 60 -- Minimum time to watch before marking as watched (seconds)
local ERROR_RETRY_COUNT = 3 -- Number of times to retry on error
local RETRY_DELAY = 5 -- Delay between retries in seconds
local STREAM_SWITCH_DELAY = 2 -- Delay between switching streams in seconds

-- Track state
local marked_streams = {}
local playlist_initialized = false
local manual_navigation = false
local current_error_count = 0
local stream_start_time = nil
local is_stream_active = false

-- Helper function to make HTTP requests with better error handling
function http_request(url, method, headers, data)
    msg.debug(string.format("Making HTTP request to: %s [%s]", url, method or "GET"))
    
    local curl_cmd = string.format(
        'curl -s -X %s %s -H "Content-Type: application/json" %s %s',
        method or "GET",
        url,
        headers or "",
        data and ("-d '" .. data .. "'") or ""
    )
    
    local curl = io.popen(curl_cmd)
    local response = curl:read('*all')
    local success, exit_code = curl:close()
    
    if not success then
        msg.error(string.format("HTTP request failed with exit code: %s", exit_code))
        return nil
    end
    
    if response and response ~= "" then
        local parsed = utils.parse_json(response)
        if not parsed then
            msg.error("Failed to parse JSON response")
            msg.debug("Raw response: " .. response)
            return nil
        end
        return parsed
    end
    
    return nil
end

-- Get current screen number from socket path
function get_current_screen()
    if current_screen then return current_screen end
    
    local socket_path = mp.get_property("input-ipc-server")
    if socket_path then
        msg.debug("Socket path: " .. socket_path)
        local screen = string.match(socket_path, "mpv%-ipc%-(%d+)")
        if screen then
            current_screen = tonumber(screen)
            msg.info("Detected screen number: " .. current_screen)
            return current_screen
        end
    end
    
    msg.error("Could not determine screen number")
    return nil
end

-- Helper function to check if a value exists in a table
function has_value(tab, val)
    if not tab then return false end
    for _, value in ipairs(tab) do
        if value == val then
            return true
        end
    end
    return false
end

-- Get next unwatched URL from queue
function get_next_unwatched()
    local screen = get_current_screen()
    if not screen then 
        msg.error("Cannot get next stream: screen number unknown")
        return nil 
    end

    msg.info("Fetching next unwatched stream for screen " .. screen)
    
    local response = http_request(API_URL .. "/streams/queue/" .. screen)
    if response then
        -- Get watched streams
        local watched = http_request(API_URL .. "/streams/watched")
        local watched_urls = watched or {}
        
        msg.debug(string.format("Found %d streams in queue", #response))
        msg.debug(string.format("Found %d watched streams", #watched_urls))

        -- Find first unwatched stream
        for _, stream in ipairs(response) do
            if not has_value(watched_urls, stream.url) then
                msg.info("Found next unwatched stream: " .. stream.url)
                return stream.url
            end
        end
        
        msg.info("No unwatched streams found in queue")
    else
        msg.error("Failed to fetch queue")
    end
    
    return nil
end

-- Check if URL is already playing on another screen
function check_url_duplicate(url)
    -- Skip checking if URL is nil
    if not url then
        msg.debug("Skipping duplicate check for nil URL")
        return false, nil
    end

    -- Skip checking playlist files
    if string.match(url, "playlist%-screen%d+") then
        msg.debug("Skipping duplicate check for playlist file")
        return false, nil
    end

    -- Skip checking if this is a local file
    if string.match(url, "^/") then
        msg.debug("Skipping duplicate check for local file")
        return false, nil
    end
    
    -- Skip checking for about:blank
    if url == "about:blank" then
        msg.debug("Skipping about:blank update")
        return false, nil
    end

    -- Normalize URL for comparison
    local normalized_url = url
    if url:match("twitch.tv/") and not url:match("^https://") then
        normalized_url = "https://twitch.tv/" .. url:match("twitch.tv/(.+)")
    elseif url:match("youtube.com/") and not url:match("^https://") then
        normalized_url = "https://youtube.com/" .. url:match("youtube.com/(.+)")
    end

    msg.debug("Checking for duplicate stream: " .. normalized_url)
    
    local response = http_request(API_URL .. "/streams/active")
    if response then
        local current_screen = get_current_screen()
        for _, stream in ipairs(response) do
            -- Normalize the stream URL for comparison
            local stream_url = stream.url
            if stream_url:match("twitch.tv/") and not stream_url:match("^https://") then
                stream_url = "https://twitch.tv/" .. stream_url:match("twitch.tv/(.+)")
            elseif stream_url:match("youtube.com/") and not stream_url:match("^https://") then
                stream_url = "https://youtube.com/" .. stream_url:match("youtube.com/(.+)")
            end
            
            -- Only consider it a duplicate if:
            -- 1. Same URL (after normalization)
            -- 2. Different screen
            -- 3. The other screen has a lower number (higher priority)
            if stream_url == normalized_url and 
               stream.screen ~= current_screen and 
               stream.screen < current_screen then
                msg.warn(string.format("URL already playing on higher priority screen %d", stream.screen))
                return true, stream.screen
            end
        end
    end
    
    return false, nil
end

-- Handle end of playlist
function handle_end_of_playlist()
    local screen = get_current_screen()
    if not screen then return end

    msg.info("Playlist ended, requesting new streams")
    
    -- Request new streams from manager
    local data = utils.format_json({
        screen = screen,
        type = "request_update"
    })
    
    http_request(
        API_URL .. "/streams/queue/" .. screen,
        "POST",
        nil,
        data
    )
end

-- Mark current stream as watched
function mark_current_watched()
    local path = mp.get_property("path")
    if not path or not stream_start_time then return end

    -- Only mark as watched if we've watched at least MIN_WATCH_TIME seconds
    local current_time = os.time()
    local watch_duration = current_time - stream_start_time
    
    if watch_duration >= MIN_WATCH_TIME then
        -- Skip if already marked
        if marked_streams[path] then
            msg.debug("Stream already marked as watched: " .. path)
            return
        end

        msg.info(string.format("Marking as watched: %s (watched for %d seconds)", path, watch_duration))
        marked_streams[path] = true
        
        local data = utils.format_json({
            url = path,
            screen = get_current_screen()
        })
        
        local response = http_request(
            API_URL .. "/streams/watched",
            "POST",
            nil,
            data
        )
        
        if response then
            msg.info("Stream marked as watched")
            -- Remove from playlist only after successfully marking as watched
            local pos = mp.get_property_number("playlist-pos")
            if pos ~= nil then
                mp.commandv("playlist-remove", pos)
                msg.info(string.format("Removed watched stream from playlist: %s", path))
            end
        else
            msg.error("Failed to mark stream as watched")
        end
    end
end

-- Update screen info
function update_screen_info()
    local screen = get_current_screen()
    if not screen then 
        msg.debug("Cannot update screen info: screen number unknown")
        return 
    end
    
    local url = mp.get_property("path")
    if not url then 
        msg.debug("No URL available for update")
        return 
    end
    
    -- Skip playlist files
    if string.match(url, "playlist%-screen%d+") then
        msg.debug("Skipping playlist file update")
        return
    end
    
    -- Skip about:blank
    if url == "about:blank" then
        msg.debug("Skipping about:blank update")
        return
    end
    
    -- Normalize URL if needed
    local normalized_url = url
    if url:match("twitch.tv/") and not url:match("^https://") then
        normalized_url = "https://twitch.tv/" .. url:match("twitch.tv/(.+)")
    elseif url:match("youtube.com/") and not url:match("^https://") then
        normalized_url = "https://youtube.com/" .. url:match("youtube.com/(.+)")
    end
    
    -- Only update if URL has changed
    if normalized_url ~= current_url then
        msg.info("URL changed, updating stream info")
        
        local is_duplicate, other_screen = check_url_duplicate(normalized_url)
        if is_duplicate then
            msg.warn(string.format("URL already playing on screen %d, moving to next stream", other_screen))
            
            -- Mark this URL as watched to avoid it coming back in the queue
            local data = utils.format_json({
                url = normalized_url,
                screen = get_current_screen()
            })
            
            http_request(
                API_URL .. "/streams/watched",
                "POST",
                nil,
                data
            )
            
            -- Only skip to next stream if not in manual navigation mode
            if not manual_navigation then
                -- Add a small delay before playing next stream
                mp.add_timeout(STREAM_SWITCH_DELAY, function()
                    play_next_stream()
                end)
            else
                mp.osd_message(string.format("Warning: This stream is already playing on screen %d", other_screen), 5)
            end
            return
        end
        
        current_url = normalized_url
        
        -- Update screen info via API
        local data = utils.format_json({
            url = normalized_url,
            screen = screen,
            quality = mp.get_property("options/quality") or "best",
            notify_only = true  -- Add flag to indicate this is just a notification
        })
        
        msg.debug("Sending update to API: " .. data)
        
        local response = http_request(
            API_URL .. "/streams/url",
            "POST",
            nil,
            data
        )
        
        -- Reset stream start time for watched tracking
        stream_start_time = os.time()
    end
end

-- Show stream info overlay
function show_stream_info()
    local screen = get_current_screen()
    if not screen then return end

    msg.info("Gathering stream information for display")

    -- Get all relevant information
    local active = http_request(API_URL .. "/streams/active")
    local queue = http_request(API_URL .. "/streams/queue/" .. screen)
    local config = http_request(API_URL .. "/screens/" .. screen)
    local watched = http_request(API_URL .. "/streams/watched")

    -- Get current playlist information
    local playlist_count = mp.get_property_number("playlist-count") or 0
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local current_url = mp.get_property("path")

    -- Format info text
    local info = string.format("Screen %d Info:\n", screen)
    
    -- Active streams section
    info = info .. "\nActive Streams:\n"
    if active and #active > 0 then
        for _, stream in ipairs(active) do
            info = info .. string.format("  Screen %d: %s\n", stream.screen, stream.url)
            if stream.title then
                info = info .. string.format("    Title: %s\n", stream.title)
            end
        end
    else
        info = info .. "  No active streams\n"
    end

    -- Current Playlist section
    info = info .. "\nCurrent Playlist:\n"
    if playlist_count > 0 then
        info = info .. string.format("  Position: %d/%d\n", playlist_pos + 1, playlist_count)
        -- Get and display all playlist items
        for i = 0, playlist_count - 1 do
            local item_url = mp.get_property(string.format("playlist/%d/filename", i))
            local is_current = i == playlist_pos
            local watched_mark = has_value(watched or {}, item_url) and " (watched)" or ""
            local current_mark = is_current and " *CURRENT*" or ""
            info = info .. string.format("  %d: %s%s%s\n", i + 1, item_url, watched_mark, current_mark)
        end
    else
        info = info .. "  Playlist is empty\n"
    end

    -- Check for remaining streams in JSON file
    local remaining_path = string.format("/home/all/repos/LiveLink/logs/playlists/remaining-screen%d.json", screen)
    local remaining_file = io.open(remaining_path, "r")
    if remaining_file then
        local content = remaining_file:read("*all")
        remaining_file:close()
        if content and content ~= "" then
            local remaining = utils.parse_json(content)
            if remaining and #remaining > 0 then
                info = info .. "\nRemaining Streams:\n"
                for i, url in ipairs(remaining) do
                    local watched_mark = has_value(watched or {}, url) and " (watched)" or ""
                    info = info .. string.format("  %d: %s%s\n", i, url, watched_mark)
                end
            end
        end
    end

    -- Queue section
    info = info .. "\nQueue:\n"
    if queue and #queue > 0 then
        for i, stream in ipairs(queue) do
            local watched_mark = has_value(watched or {}, stream.url) and " (watched)" or ""
            info = info .. string.format("  %d: %s%s\n", i, stream.url, watched_mark)
            if stream.title then
                info = info .. string.format("    Title: %s\n", stream.title)
            end
        end
    else
        info = info .. "  Queue is empty\n"
    end

    -- Configuration section
    if config then
        info = info .. "\nScreen Configuration:\n"
        info = info .. string.format("  Enabled: %s\n", config.enabled and "yes" or "no")
        info = info .. string.format("  Quality: %s\n", config.quality or "best")
        info = info .. string.format("  Volume: %d\n", config.volume or 100)
        
        -- Current playback info
        local pos = mp.get_property_number("percent-pos") or 0
        info = info .. string.format("\nPlayback Progress: %.1f%%\n", pos)
    end

    msg.debug("Displaying info overlay:\n" .. info)
    mp.osd_message(info, info_display_time)
end

-- Clear watched streams
function clear_watched()
    msg.info("Clearing watched streams history")
    
    local response = http_request(API_URL .. "/streams/watched", "DELETE")
    if response then
        msg.info("Watched streams history cleared")
        mp.osd_message("Cleared watched streams history", 3)
        -- Clear local marked streams cache
        marked_streams = {}
    else
        msg.error("Failed to clear watched streams history")
        mp.osd_message("Failed to clear watched streams history", 3)
    end
end

-- Refresh current stream
function refresh_stream()
    local url = current_url
    if url then
        msg.info("Refreshing current stream: " .. url)
        mp.commandv("loadfile", url)
    else
        msg.warn("No current stream to refresh")
    end
end

-- Add this new function for playlist initialization
function initialize_playlist()
    -- Return early if already initialized to prevent duplicate initialization
    if playlist_initialized then 
        msg.debug("Playlist already initialized, skipping")
        return true 
    end
    
    local screen = get_current_screen()
    if not screen then 
        msg.error("Cannot initialize playlist: screen number unknown")
        return false 
    end
    
    msg.info("Initializing playlist for screen " .. screen)
    
    -- Fetch queue from API
    local response = http_request(API_URL .. "/streams/queue/" .. screen)
    if response and #response > 0 then
        msg.info(string.format("Found %d streams in queue", #response))
        
        -- Get watched streams to filter
        local watched = http_request(API_URL .. "/streams/watched")
        local watched_urls = watched or {}
        
        -- Clear the current playlist first
        mp.commandv("playlist-clear")
        
        -- Add unwatched streams to playlist
        local added = 0
        for _, stream in ipairs(response) do
            if not has_value(watched_urls, stream.url) then
                -- Normalize URL if needed
                local url = stream.url
                if url:match("twitch.tv/") and not url:match("^https://") then
                    url = "https://twitch.tv/" .. url:match("twitch.tv/(.+)")
                elseif url:match("youtube.com/") and not url:match("^https://") then
                    url = "https://youtube.com/" .. url:match("youtube.com/(.+)")
                end
                
                msg.debug("Adding to playlist: " .. url)
                mp.commandv("loadfile", url, "append")
                added = added + 1
            end
        end
        
        msg.info(string.format("Added %d unwatched streams to playlist", added))
        playlist_initialized = true
        return added > 0
    else
        msg.info("No streams found in queue")
        playlist_initialized = true  -- Mark as initialized even if empty to prevent repeated attempts
        return false
    end
end

-- Update the playlist position observer
mp.observe_property("playlist-pos", "number", function(name, value)
    if value == nil then return end
    
    local url = mp.get_property("path")
    if not url then return end
    
    msg.info(string.format("Playlist position changed to %d: %s", value, url))
    
    -- Initialize playlist if needed
    if not playlist_initialized then
        initialize_playlist()
    end
    
    -- Check if this URL is already playing on another screen
    local is_duplicate, other_screen = check_url_duplicate(url)
    if is_duplicate then
        msg.warn(string.format("URL already playing on screen %d, skipping", other_screen))
        if not manual_navigation then
            -- Only auto-skip if not manually navigating
            play_next_stream()
        end
        return
    end
    
    -- Update stream info for the new position
    update_screen_info()
end)

-- Add handlers for manual navigation
mp.add_key_binding("ENTER", "playlist-play-selected", function()
    manual_navigation = true
    local pos = mp.get_property_number("playlist-pos") or 0
    local count = mp.get_property_number("playlist-count") or 0
    
    -- Only allow playing current or future items
    local selected_pos = mp.get_property_number("playlist-pos-1") or 0
    if selected_pos < pos then
        mp.osd_message("Cannot play previous streams", 2)
        return
    end
    
    if selected_pos >= count then
        mp.osd_message("Invalid playlist position", 2)
        return
    end
    
    local url = mp.get_property(string.format("playlist/%d/filename", selected_pos))
    if url then
        msg.info("Manual selection of playlist item: " .. url)
        -- Force load the selected URL
        mp.commandv("loadfile", url)
    end
    
    -- Reset manual navigation flag after a short delay
    mp.add_timeout(1, function()
        manual_navigation = false
    end)
end)

-- Add error handling for stream failures
mp.register_event("end-file", function(event)
    msg.info(string.format("File ended event triggered: %s (playlist-pos: %s/%s)", 
        event.reason or "unknown reason",
        mp.get_property("playlist-pos"),
        mp.get_property("playlist-count")))
    
    -- Reset stream state
    is_stream_active = false
    
    if event.reason == "error" then
        current_error_count = current_error_count + 1
        msg.warn(string.format("Stream error occurred (attempt %d/%d)", current_error_count, ERROR_RETRY_COUNT))
        
        if current_error_count < ERROR_RETRY_COUNT then
            -- Retry current stream after delay
            mp.add_timeout(RETRY_DELAY, function()
                local current_url = mp.get_property("path")
                if current_url then
                    msg.info("Retrying stream: " .. current_url)
                    mp.commandv("loadfile", current_url)
                end
            end)
            return
        else
            msg.error("Max retry attempts reached, moving to next stream")
            current_error_count = 0
        end
    elseif event.reason == "eof" or event.reason == "stop" then
        -- Only mark as watched and proceed if stream ended normally
        mark_current_watched()
    end
    
    -- Add delay before playing next stream
    mp.add_timeout(STREAM_SWITCH_DELAY, function()
        current_url = nil
        play_next_stream()
    end)
end)

-- Handle initial about:blank URL
function handle_initial_blank()
    local url = mp.get_property("path")
    if url == "about:blank" then
        msg.info("Initial about:blank detected, initializing playlist")
        
        -- Clear any existing playlist
        mp.commandv("playlist-clear")
        playlist_initialized = false
        
        -- Add a delay before initializing playlist
        mp.add_timeout(3, function()
            local success = initialize_playlist()
            if success then
                -- If initialization was successful, start playing first item after a short delay
                mp.add_timeout(1, function()
                    msg.info("Starting playback of initial playlist")
                    mp.commandv("playlist-play-index", "0")
                end)
            else
                -- If no streams available, show message
                msg.info("No streams available for initial playback")
                mp.osd_message("No streams available. Please add streams to the queue.", 5)
            end
        end)
    end
end

-- Register file-loaded event handler
mp.register_event("file-loaded", function()
    msg.info("File loaded event triggered")
    local url = mp.get_property("path")
    
    -- Skip if no URL
    if not url then return end
    
    -- Reset stream state
    stream_start_time = os.time()
    is_stream_active = true
    
    -- Handle initial about:blank URL
    if url == "about:blank" then
        handle_initial_blank()
        return
    end
    
    -- Add a small delay before processing the URL to allow the player to stabilize
    mp.add_timeout(0.5, function()
        msg.debug(string.format("Processing URL: %s", url))
        update_screen_info()
        
        -- Check if we need to refresh based on time
        local current_time = os.time()
        if current_time - last_refresh_time >= REFRESH_INTERVAL then
            msg.info("Refresh interval reached, refreshing stream")
            last_refresh_time = current_time
            refresh_stream()
        end
    end)
end)

-- Update play_next_stream function
function play_next_stream()
    local screen = get_current_screen()
    if not screen then return end

    msg.info("Attempting to play next stream")
    
    -- Reset error count when moving to next stream
    current_error_count = 0
    
    -- Get playlist info
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local playlist_count = mp.get_property_number("playlist-count") or 0
    
    msg.debug(string.format("Current playlist position: %d/%d", playlist_pos + 1, playlist_count))
    
    -- If we have more items in playlist, try to play next
    if playlist_count > 1 and playlist_pos < playlist_count - 1 then
        -- Add delay before playing next stream
        mp.add_timeout(STREAM_SWITCH_DELAY, function()
            msg.info("Playing next item in playlist")
            mp.commandv("playlist-next")
        end)
        return
    end
    
    -- If we reach here, we need to get new streams
    msg.info("Reached end of playlist, fetching new streams")
    
    -- Clear the current playlist
    mp.commandv("playlist-clear")
    playlist_initialized = false
    
    -- Initialize new playlist with delay
    mp.add_timeout(STREAM_SWITCH_DELAY * 2, function()
        local success = initialize_playlist()
        if success then
            -- If initialization was successful, start playing first item after a short delay
            mp.add_timeout(STREAM_SWITCH_DELAY, function()
                msg.info("Starting playback of new playlist")
                mp.commandv("playlist-play-index", "0")
            end)
        else
            -- If no new streams, request update from server
            msg.info("No new streams found, requesting update from server")
            handle_end_of_playlist()
            
            -- Show a message to the user
            mp.osd_message("No more streams available. Requesting new content...", 5)
        end
    end)
end

-- Add handler for manual playlist navigation
mp.add_key_binding("ENTER", "playlist-play-selected", function()
    manual_navigation = true
    local pos = mp.get_property_number("playlist-pos") or 0
    local count = mp.get_property_number("playlist-count") or 0
    
    -- Only allow playing current or future items
    local selected_pos = mp.get_property_number("playlist-pos-1") or 0
    if selected_pos < pos then
        mp.osd_message("Cannot play previous streams", 2)
        return
    end
    
    if selected_pos >= count then
        mp.osd_message("Invalid playlist position", 2)
        return
    end
    
    local url = mp.get_property(string.format("playlist/%d/filename", selected_pos))
    if url then
        msg.info("Manual selection of playlist item: " .. url)
        -- Force load the selected URL
        mp.commandv("loadfile", url)
    end
    
    -- Reset manual navigation flag after a short delay
    mp.add_timeout(1, function()
        manual_navigation = false
    end)
end)

-- Add handler for playlist-next command
mp.add_key_binding("PGDWN", "playlist-next-stream", function()
    play_next_stream()
end)

-- Add handler for playlist-prev command
mp.add_key_binding("PGUP", "playlist-prev-stream", function()
    -- Disable going backwards in playlist
    mp.osd_message("Cannot go back in playlist", 2)
end)

-- Add hook to check URL on load
mp.add_hook("on_load", 50, function()
    local url = mp.get_property("path")
    if not url then return end
    
    local playlist_pos = mp.get_property("playlist-pos")
    local playlist_count = mp.get_property("playlist-count")
    
    msg.debug(string.format("Checking URL on load: %s (playlist-pos: %s/%s)", url, playlist_pos, playlist_count))
    
    -- Check if this URL is already playing on another screen
    local is_duplicate, other_screen = check_url_duplicate(url)
    if is_duplicate then
        msg.warn(string.format("URL already playing on screen %d, skipping", other_screen))
        play_next_stream()
    end
end)

-- Function to auto-start streams on a specific screen
function auto_start_screen(screen)
    msg.info(string.format("Auto-starting streams on screen %d", screen))
    
    local data = utils.format_json({
        screen = screen
    })
    
    local response = http_request(
        API_URL .. "/streams/autostart",
        "POST",
        nil,
        data
    )
    
    if response then
        mp.osd_message(string.format("Auto-starting streams on screen %d", screen), 3)
    else
        mp.osd_message(string.format("Failed to auto-start streams on screen %d", screen), 3)
    end
end

-- Register key bindings
mp.add_key_binding("F2", "show-stream-info", show_stream_info)
mp.add_key_binding("F5", "refresh-stream", refresh_stream)
mp.add_key_binding("Ctrl+F5", "clear-watched", clear_watched)
mp.add_key_binding("Alt+k", "auto-start-screen-2", function()
    auto_start_screen(2)
end)
mp.add_key_binding("Alt+l", "auto-start-screen-1", function()
    auto_start_screen(1)
end)

-- Log initialization
msg.info("LiveLink MPV script initialized")
if get_current_screen() then
    msg.info(string.format("Running on screen %d", get_current_screen()))
else
    msg.warn("Could not determine screen number")
end