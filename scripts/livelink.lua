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

-- Track already marked streams
local marked_streams = {}

-- Track playlist state
local playlist_initialized = false
local manual_navigation = false

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

    msg.debug("Checking for duplicate stream: " .. url)
    
    local response = http_request(API_URL .. "/streams/active")
    if response then
        local current_screen = get_current_screen()
        for _, stream in ipairs(response) do
            -- Only consider it a duplicate if:
            -- 1. Same URL
            -- 2. Different screen
            -- 3. The other screen has a lower number (higher priority)
            if stream.url == url and 
               stream.screen ~= current_screen and 
               stream.screen < current_screen then
                msg.warn(string.format("URL already playing on higher priority screen %d", stream.screen))
                return true, stream.screen
            end
        end
    end
    
    msg.debug("No duplicates found")
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
    if not path then return end

    -- Skip marking playlist files
    if string.match(path, "playlist%-screen%d+") then
        msg.debug("Skipping playlist file")
        return
    end

    -- Only mark as watched if we've watched at least 30 seconds or 20% of the video
    local duration = mp.get_property_number("duration") or 0
    local position = mp.get_property_number("time-pos") or 0
    local threshold = math.min(30, duration * 0.2)
    
    if position >= threshold then
        -- Skip if already marked
        if marked_streams[path] then
            msg.debug("Stream already marked as watched: " .. path)
            return
        end

        msg.info("Marking as watched: " .. path)
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
            -- Check if we should move to next stream
            local playlist_count = mp.get_property_number("playlist-count") or 0
            local playlist_pos = mp.get_property_number("playlist-pos") or 0
            
            if playlist_count > 0 and playlist_pos < playlist_count - 1 then
                mp.commandv("playlist-next")
            else
                handle_end_of_playlist()
            end
        else
            msg.error("Failed to mark stream as watched")
        end
    end
end

-- Update screen info
function update_screen_info()
    local screen = get_current_screen()
    if not screen then return end
    
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
    
    -- Normalize URL if needed
    if url:match("twitch.tv/") and not url:match("^https://") then
        url = "https://twitch.tv/" .. url:match("twitch.tv/(.+)")
    elseif url:match("youtube.com/") and not url:match("^https://") then
        url = "https://youtube.com/" .. url:match("youtube.com/(.+)")
    end
    
    -- Only update if URL has changed
    if url ~= current_url then
        msg.info("URL changed, updating stream info")
        
        local is_duplicate, other_screen = check_url_duplicate(url)
        if is_duplicate then
            msg.warn(string.format("URL already playing on screen %d, moving to next stream", other_screen))
            -- Instead of stopping, try to play next stream
            play_next_stream()
            return
        end
        
        current_url = url
        
        -- Update screen info via API
        local data = utils.format_json({
            url = url,
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
        
        if response then
            if response.message then
                msg.info("API response: " .. response.message)
                if response.message:match("already playing") then
                    -- If stream is already playing somewhere, move to next
                    play_next_stream()
                    return
                end
            end
            msg.info("Stream info update sent")
        else
            msg.error("Failed to update stream info")
        end
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
    if playlist_initialized then return end
    
    local screen = get_current_screen()
    if not screen then return end
    
    msg.info("Initializing playlist for screen " .. screen)
    
    -- Check for remaining streams file
    local remaining_path = string.format("/home/all/repos/LiveLink/logs/playlists/remaining-screen%d.json", screen)
    local remaining_file = io.open(remaining_path, "r")
    
    if remaining_file then
        local content = remaining_file:read("*all")
        remaining_file:close()
        
        if content and content ~= "" then
            local remaining = utils.parse_json(content)
            if remaining and #remaining > 0 then
                msg.info(string.format("Found %d streams to load", #remaining))
                
                -- Load all streams into playlist
                for _, url in ipairs(remaining) do
                    mp.commandv("loadfile", url, "append")
                end
                
                -- Remove the remaining streams file since we've loaded everything
                os.remove(remaining_path)
                
                playlist_initialized = true
                return true
            end
        end
    end
    
    return false
end

-- Update the playlist position observer
mp.observe_property("playlist-pos", "number", function(name, value)
    if value == nil then return end
    
    local url = mp.get_property("path")
    if not url then return end
    
    -- Skip playlist files
    if string.match(url, "playlist%-screen%d+") then
        msg.debug("Skipping playlist file processing")
        return
    end
    
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
            mp.commandv("playlist-next", "force")
        end
        return
    end
    
    -- Update stream info for the new position
    update_screen_info()
    
    -- Mark as watched after a short delay to ensure stream is actually playing
    mp.add_timeout(2, mark_current_watched)
end)

-- Add handlers for manual navigation
mp.add_key_binding("ENTER", "playlist-play-selected", function()
    manual_navigation = true
    local pos = mp.get_property_number("playlist-pos") or 0
    local url = mp.get_property(string.format("playlist/%d/filename", pos))
    
    if url then
        msg.info("Manual selection of playlist item: " .. url)
        -- Force load the selected URL
        mp.commandv("loadfile", url, "replace")
    end
    
    -- Reset manual navigation flag after a short delay
    mp.add_timeout(1, function()
        manual_navigation = false
    end)
end)

-- Update the file-loaded event handler
mp.register_event("file-loaded", function()
    msg.info("File loaded event triggered")
    local url = mp.get_property("path")
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local playlist_count = mp.get_property_number("playlist-count") or 0
    
    msg.debug(string.format("File loaded: %s (playlist pos: %d/%d)", 
        url or "nil",
        playlist_pos + 1,
        playlist_count))
    
    -- Initialize playlist if needed
    if not playlist_initialized then
        initialize_playlist()
    end
    
    -- Skip playlist files
    if not string.match(url, "playlist%-screen%d+") then
        msg.debug(string.format("Processing URL: %s", url))
        update_screen_info()
        -- Mark as watched after a short delay to ensure stream is actually playing
        mp.add_timeout(2, mark_current_watched)
    else
        msg.debug("Skipping playlist file processing")
    end
end)

-- Update play_next_stream function
function play_next_stream()
    local screen = get_current_screen()
    if not screen then return end

    msg.info("Attempting to play next stream")
    
    -- Initialize playlist if needed
    if not playlist_initialized and initialize_playlist() then
        -- If we just initialized the playlist, start playing
        mp.commandv("playlist-play-index", "0")
        return
    end
    
    -- Get playlist info
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local playlist_count = mp.get_property_number("playlist-count") or 0
    
    msg.debug(string.format("Current playlist position: %d/%d", playlist_pos + 1, playlist_count))
    
    -- If we have more items in playlist, let MPV handle it
    if playlist_pos + 1 < playlist_count then
        msg.info("Using MPV playlist to play next stream")
        mp.commandv("playlist-next", "force")
        return
    end
    
    -- If we reach here, we've reached the end of the playlist
    msg.info("End of playlist reached")
    -- Request new streams from the server
    handle_end_of_playlist()
end

-- Register event handlers
mp.register_event("end-file", function(event)
    msg.info(string.format("File ended event triggered: %s (playlist-pos: %s/%s)", 
        event.reason or "unknown reason",
        mp.get_property("playlist-pos"),
        mp.get_property("playlist-count")))
    
    -- Only proceed if the file ended naturally and it's not a playlist file
    local url = mp.get_property("path")
    if event.reason == "eof" and not string.match(url, "playlist%-screen%d+") then
        current_url = nil
        -- Let MPV handle playlist progression
        play_next_stream()
    end
end)

-- Initialize
mp.add_hook("on_load", 50, function()
    local url = mp.get_property("path")
    if url then
        msg.debug(string.format("Checking URL on load: %s (playlist-pos: %s/%s)", 
            url,
            mp.get_property("playlist-pos"),
            mp.get_property("playlist-count")))
            
        -- Skip duplicate check for playlist files
        if string.match(url, "playlist%-screen%d+") then
            msg.debug("Skipping duplicate check for playlist file")
            return true
        end
            
        local is_duplicate, other_screen = check_url_duplicate(url)
        if is_duplicate then
            msg.warn(string.format("URL already playing on screen %d", other_screen))
            return false
        end
    end
    return true
end)

-- Register key bindings
mp.add_key_binding("F2", "show-stream-info", show_stream_info)
mp.add_key_binding("F5", "refresh-stream", refresh_stream)
mp.add_key_binding("Ctrl+F5", "clear-watched", clear_watched)

-- Log initialization
msg.info("LiveLink MPV script initialized")
if get_current_screen() then
    msg.info(string.format("Running on screen %d", get_current_screen()))
else
    msg.warn("Could not determine screen number")
end