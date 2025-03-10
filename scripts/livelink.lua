-- LiveLink MPV Script
-- Features:
-- - Auto queue management
-- - Stream status tracking
-- - Watched stream tracking
-- - Multi-screen support
-- - Stream info display
-- - Auto-refresh capability

-- Required modules
local utils = require('mp.utils')
local msg = require('mp.msg')
local options = require('mp.options')

-- Configuration
local API_URL = "http://localhost:3001/api"
local info_display_time = 10 -- How long to show info overlay (seconds)
local REFRESH_INTERVAL = 30 * 60 -- 30 minutes in seconds
local last_refresh_time = os.time()
local MIN_WATCH_TIME = 60 -- Minimum time to watch before marking as watched (seconds)
local ERROR_RETRY_COUNT = 3 -- Number of times to retry on error
local RETRY_DELAY = 2 -- Delay between retries in seconds (reduced from 5)
local STREAM_SWITCH_DELAY = 1.0 -- Delay between switching streams in seconds (reduced from 1)
local WATCHED_CHECK_INTERVAL = 60 -- Check every minute

-- Track state
local marked_streams = {}
local playlist_initialized = false
local manual_navigation = false
local current_error_count = 0
local stream_start_time = nil
local is_stream_active = false
local active_process = nil
local is_shutting_down = false
local key_bindings_registered = false
local current_url = nil
local current_screen = nil

-- Add process state tracking
local process_state = {
    starting = false,
    shutting_down = false,
    error_count = 0,
    last_health_check = os.time()
}

-- Get script options
local script_opts = {
    screen = 1  -- Default screen number
}

-- Read options
options.read_options(script_opts, "livelink")

-- Override with command line option if present
local screen_opt = mp.get_opt("screen")
if screen_opt then
    script_opts.screen = tonumber(screen_opt) or 1
end

-- Initialize screen number once
current_screen = script_opts.screen
msg.info(string.format("LiveLink MPV script initialized"))
msg.info(string.format("Screen number set to: %d", current_screen))

-- Add safer API endpoint handling
local API = {
    streams = {
        playlist = API_URL .. "/streams/playlist",
        progress = API_URL .. "/streams/progress",
        watched = API_URL .. "/streams/watched",
        queue = function(screen) return API_URL .. "/streams/queue/" .. screen end,
        next = function(screen) return API_URL .. "/streams/next/" .. screen end,
        autostart = API_URL .. "/streams/autostart",
        restart = API_URL .. "/streams/restart",
        shutdown = API_URL .. "/streams/shutdown",
        active = API_URL .. "/streams/active"
    },
    log = API_URL .. "/log"
}

-- Get screen number from script options or socket path
function get_current_screen()
    return current_screen
end

-- Add safer API request function
function api_request(endpoint, method, data)
    if not endpoint then return nil end
    
    local headers = "Content-Type: application/json"
    local json_data = data and utils.format_json(data) or nil
    
    return http_request(endpoint, method, headers, json_data)
end

-- Helper function to send messages to node console with better error handling
function send_to_node(message_type, data)
    local screen = get_current_screen()
    if not screen then
        msg.error("Failed to send message to node: screen number unknown")
        return false
    end

    local message = utils.format_json({
        screen = screen,
        type = message_type,
        data = data
    })

    if not message then
        msg.error("Failed to format JSON message")
        return false
    end

    local success = http_request(
        API.log,
        "POST",
        "Content-Type: application/json",
        message
    )

    return success ~= nil
end

-- Helper function to log with node console and fallback to mpv log
function log_to_node(level, message)
    if not level or not message then return end
    
    -- Validate level
    if type(level) ~= "string" or type(message) ~= "string" then
        msg[level](message)
        return
    end
    
    -- Log to mpv first
    msg[level](message)
    
    -- Then try to send to node using send_to_node
    local success = send_to_node("log", {
        level = level,
        message = message
    })
    
    if not success then
        msg.warn("Failed to send log message to node")
    end
end

-- Helper function to validate URLs
function is_valid_url(url)
    if not url or type(url) ~= "string" then
        return false
    end
    
    -- Basic URL validation
    return url:match("^https?://") ~= nil
end

-- Improve HTTP request function with better error handling and fallback
function http_request(url, method, headers, data)
    if not url then
        msg.error("Invalid URL for HTTP request")
        return nil
    end
    
    method = method or "GET"
    
    -- Build the curl command
    local command = {"curl", "-s", "-X", method, url}
    
    -- Add headers if provided
    if headers then
        table.insert(command, "-H")
        table.insert(command, headers)
    end
    
    -- Add data if provided
    if data then
        table.insert(command, "-d")
        table.insert(command, data)
    end
    
    -- Execute the command
    local response = utils.subprocess({
        args = command,
        cancellable = false,
    })
    
    -- Check for network errors
    if response.status ~= 0 then
        msg.warn(string.format("HTTP request failed with status %d: %s", response.status, response.stderr or "Unknown error"))
        
        -- For API requests, create a fallback response for critical functions
        if url:match("/api/streams/") then
            if url:match("/api/streams/autostart") then
                msg.info("Network error detected, using fallback for autostart")
                return { success = true, message = "Fallback response" }
            elseif url:match("/api/streams/queue") then
                msg.info("Network error detected, using fallback for queue")
                -- Return an empty response that won't trigger further requests
                return {}
            end
        end
        
        return nil
    end
    
    -- Parse JSON response
    if response.stdout and response.stdout ~= "" then
        local success, json_data = pcall(utils.parse_json, response.stdout)
        if success and json_data then
            return json_data
        else
            msg.warn("Failed to parse JSON response: " .. (response.stdout:sub(1, 100) .. (response.stdout:len() > 100 and "..." or "")))
            return { raw = response.stdout }
        end
    end
    
    return {}
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
    
    local response = http_request(API.streams.queue(screen))
    if response then
        -- Get watched streams
        local watched = http_request(API.streams.watched)
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
    
    local response = http_request(API.streams.active, "GET")
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

-- Add network connectivity check function
function check_network_connectivity()
    local command = {"ping", "-c", "1", "-W", "2", "8.8.8.8"}
    local response = utils.subprocess({
        args = command,
        cancellable = false,
    })
    
    return response.status == 0
end

-- Add a flag to track if we're already handling an end-of-playlist event
local handling_end_of_playlist = false

-- Modify handle_end_of_playlist function to handle network failures
function handle_end_of_playlist()
    -- Don't request new streams if we're shutting down
    if is_shutting_down then
        log_to_node("info", "Player is shutting down, not requesting new streams")
        return
    end

    -- Prevent infinite loops by checking if we're already handling an end-of-playlist event
    if handling_end_of_playlist then
        log_to_node("info", "Already handling end of playlist, not requesting new streams")
        return
    end

    -- Set the flag to indicate we're handling an end-of-playlist event
    handling_end_of_playlist = true
    
    -- Set a timeout to reset the flag after 30 seconds in case of failure
    mp.add_timeout(30, function()
        if handling_end_of_playlist then
            msg.warn("Resetting handling_end_of_playlist flag after timeout")
            handling_end_of_playlist = false
        end
    end)

    -- Check network connectivity
    local has_network = check_network_connectivity()
    if not has_network then
        msg.warn("No network connectivity detected, using fallback")
        
        -- Try to play a local file as fallback
        local home_dir = os.getenv("HOME") or os.getenv("USERPROFILE")
        if home_dir then
            local fallback_dirs = {
                home_dir .. "/Videos",
                home_dir .. "/Movies",
                home_dir .. "/Downloads"
            }
            
            for _, dir in ipairs(fallback_dirs) do
                local handle = io.popen('ls -1 "' .. dir .. '" 2>/dev/null | grep -E "\\.(mp4|mkv|avi|mov)$" | head -1')
                if handle then
                    local result = handle:read("*a")
                    handle:close()
                    
                    result = result:gsub("[\n\r]", "")
                    
                    if result and result ~= "" then
                        local file_path = dir .. "/" .. result
                        msg.info("Playing fallback file: " .. file_path)
                        mp.commandv("loadfile", file_path)
                        
                        -- Reset flag after successful fallback
                        mp.add_timeout(3, function()
                            handling_end_of_playlist = false
                        end)
                        return
                    end
                end
            end
        end
        
        -- If no fallback file found, try to reopen the player with a blank playlist
        msg.info("No fallback file found, reopening player with blank playlist")
        mp.commandv("loadfile", "")
        
        -- Reset flag after reopening
        mp.add_timeout(3, function()
            handling_end_of_playlist = false
        end)
        return
    end
    
    local screen = get_current_screen()
    if not screen then
        log_to_node("error", "Cannot handle end of playlist: screen number unknown")
        handling_end_of_playlist = false
        return
    end
    
    log_to_node("info", string.format("Requesting new streams for screen %d", screen))
    
    -- Request update from server
    local response = http_request(
        API.streams.autostart,
        "POST",
        "Content-Type: application/json",
        utils.format_json({ screen = screen })
    )
    
    if response and response.success then
        log_to_node("info", "Successfully requested new streams")
        -- Reset playlist initialization flag to allow new initialization
        playlist_initialized = false
        -- Add a small delay before trying to initialize again
        mp.add_timeout(STREAM_SWITCH_DELAY, function()
            initialize_playlist()
            -- Reset the flag after initialization
            handling_end_of_playlist = false
        end)
    else
        log_to_node("error", "Failed to request new streams")
        
        -- If server request failed, try to keep the player open
        msg.info("Server request failed, keeping player open with blank playlist")
        mp.commandv("loadfile", "")
        
        -- Reset the flag after reopening
        mp.add_timeout(3, function()
            handling_end_of_playlist = false
        end)
    end
end

-- Mark current stream as watched
function mark_current_watched()
    local current_url = mp.get_property("path")
    if not current_url then return end
    
    -- Send watched status to server
    local screen = get_current_screen()
    if screen then
        local data = utils.format_json({
            url = current_url,
            screen = screen
        })
        
        http_request(API.streams.watched, "POST", "Content-Type: application/json", data)
        
        -- Remove current item from playlist after marking as watched
        remove_current_from_playlist()
    end
end

-- Update screen info
function update_screen_info()
    local screen = get_current_screen()
    if not screen then 
        msg.error("Cannot update screen info: invalid screen number")
        return 
    end
    
    local url = mp.get_property("path")
    if not url then 
        msg.debug("No URL available for update")
        return 
    end
    
    -- Skip invalid URLs
    if not is_valid_url(url) then
        msg.debug("Skipping invalid URL: " .. tostring(url))
        return
    end
    
    -- Normalize URL with error handling
    local normalized_url = url
    local success, err = pcall(function()
    if url:match("twitch.tv/") and not url:match("^https://") then
        normalized_url = "https://twitch.tv/" .. url:match("twitch.tv/(.+)")
    elseif url:match("youtube.com/") and not url:match("^https://") then
        normalized_url = "https://youtube.com/" .. url:match("youtube.com/(.+)")
        end
    end)
    
    if not success then
        msg.error("Failed to normalize URL: " .. tostring(err))
        return
    end
    
    -- Only update if URL has changed
    if normalized_url ~= current_url then
        msg.info("URL changed, updating stream info")
        
        -- Update screen info via API with error handling
            local data = utils.format_json({
                url = normalized_url,
            screen = screen,
            quality = mp.get_property("options/quality") or "best",
            notify_only = true,
            log_file = get_log_filename("mpv", screen)
        })
        
        if not data then
            msg.error("Failed to format JSON data")
            return
        end
        
        msg.debug("Sending update to API: " .. data)
        
        local response = http_request(
            API_URL .. "/streams/url",
            "POST",
            "Content-Type: application/json",
            data
        )
        
        if response then
            current_url = normalized_url
        stream_start_time = os.time()
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
    local queue = http_request(API.streams.queue(screen))
    local config = http_request(API_URL .. "/screens/" .. screen)
    local watched = http_request(API.streams.watched)

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
    
    local response = http_request(API.streams.watched, "DELETE")
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

-- Add check_watched_status function
function check_watched_status(time)
    if not time then return end
    
    local url = mp.get_property("path")
    if not url then return end
    
    -- Get duration if available
    local duration = mp.get_property_number("duration")
    if not duration then return end
    
    -- Calculate watch percentage
    local watch_percent = (time / duration) * 100
    
    -- Mark as watched if:
    -- 1. Watched more than minimum time (60 seconds by default)
    -- 2. Watched more than 80% of the video
    if time >= MIN_WATCH_TIME or watch_percent >= 80 then
        if not has_value(marked_streams, url) then
            -- Send watched status to server
            local data = utils.format_json({
                url = url,
                screen = get_current_screen()
            })
            
            if data then
                http_request(API.streams.watched, "POST", "Content-Type: application/json", data)
                table.insert(marked_streams, url)
                log_to_node("info", string.format("Marked stream as watched: %s", url))
            end
        end
    end
end

-- Add error recovery function
function handle_playback_error(error)
    msg.error(string.format("Playback error: %s", error))
    
    -- Get current URL and screen
    local url = mp.get_property("path")
    local screen = get_current_screen()
    
    if not url or not screen then
        msg.error("Cannot handle error: missing URL or screen number")
        return
    end
    
    -- Log error to server
    log_to_node("error", string.format("Playback error for %s: %s", url, error))
    
    -- Remove failed stream from playlist
    remove_current_from_playlist()
    
    -- Get next stream from queue
    local response = http_request(API.streams.queue(screen), "POST", nil, utils.format_json({ screen = screen }))
    
    if response and response.url then
        msg.info(string.format("Loading next stream from queue: %s", response.url))
        mp.commandv("loadfile", response.url)
    else
        msg.info("No next stream available, requesting new streams")
        -- Request new streams from server
        local autostart_response = http_request(
            API.streams.autostart,
            "POST",
            nil,
            utils.format_json({ screen = screen })
        )
        
        if not autostart_response then
            msg.error("Failed to request new streams")
            mp.osd_message("Failed to load next stream", 3)
        end
    end
end

-- Update end-file event handler
mp.register_event("end-file", function(event)
    if event.error then
        handle_playback_error(event.error)
        return
    end
    
    -- Log the event with more details
    log_to_node("info", string.format("Playback ended with reason: %s", event.reason))
    log_to_node("debug", string.format("Current URL: %s", mp.get_property("path") or "none"))
    
    -- Mark current stream as watched before moving to next
    mark_current_watched()
    
    -- Only handle automatic navigation if not in manual mode
    if not manual_navigation then
        log_to_node("info", "Auto-navigating to next stream")
        -- Add a small delay before playing next stream
        mp.add_timeout(STREAM_SWITCH_DELAY, function()
            play_next_stream()
        end)
    else
        log_to_node("info", "Manual navigation mode - not auto-playing next stream")
    end
end)

-- Update initialize_playlist function
function initialize_playlist()
    if playlist_initialized then
        return
    end

    local current_url = mp.get_property("path")
    if not current_url then
        msg.warn("No URL available for playlist initialization")
        return
    end

    -- Create initial playlist with better error handling
    local playlist = {}
    local playlist_count = mp.get_property_number("playlist-count") or 0
    
    -- If no playlist items, try to get from queue
    if playlist_count == 0 then
        local screen = get_current_screen()
        if screen then
            local response = http_request(API.streams.queue(screen), "GET")
            if response then
                -- Add queue items to playlist
                for _, item in ipairs(response) do
                    if item.url then
                        mp.commandv("loadfile", item.url, "append")
                    end
                end
                -- Update playlist count
                playlist_count = mp.get_property_number("playlist-count") or 0
            end
        end
    end
    
    for i = 0, playlist_count - 1 do
        local item = {
            filename = mp.get_property(string.format("playlist/%d/filename", i)),
            title = mp.get_property(string.format("playlist/%d/title", i)),
            current = (i == mp.get_property_number("playlist-pos"))
        }
        table.insert(playlist, item)
    end

    -- Send playlist update to server with proper error handling
    local success, err = pcall(function()
        local data = utils.format_json({
            screen = get_current_screen(),
            data = playlist,
            type = "playlist"
        })
        
        if not data then
            error("Failed to format playlist data")
        end

        local response = http_request(
            API.streams.playlist,
            "POST",
            "Content-Type: application/json",
            data
        )

        -- Even if the response has an error, we'll consider the playlist initialized
        -- This prevents repeated attempts that might fail
        if response and response.error then
            msg.warn("Server returned error for playlist update: " .. response.error)
        end
    end)

    if not success then
        msg.warn("Failed to send playlist update: " .. (err or "unknown error"))
        -- Still mark as initialized to prevent repeated failures
    end

    playlist_initialized = true
    msg.info("Playlist initialized successfully")
end

-- Add safer property observers
function observe_properties()
    -- Observe playlist position changes
    mp.observe_property("playlist-pos", "number", function(_, pos)
        if pos then
            initialize_playlist()
        end
    end)
    
    -- Observe playback time for progress updates
    mp.observe_property("time-pos", "number", function(_, time)
        if time then
            local duration = mp.get_property_number("duration")
            if duration then
                local remaining = duration - time
                local data = utils.format_json({
                    screen = script_opts.screen,
                    position = time,
                    duration = duration,
                    remaining = remaining
                })
                
                if data then
                    http_request(API.streams.progress, "POST", "Content-Type: application/json", data)
                end
            end
        end
    end)
end

-- Initialize script
function init()
    -- Initialize screen number
    if not script_opts.screen then
        msg.error("Screen number not set")
        return
    end
    
    -- Log initialization
    msg.info(string.format("Initializing LiveLink for screen %d", script_opts.screen))
    
    -- Setup key bindings if not already done
    if not key_bindings_registered then
        -- Register key bindings
        mp.add_key_binding("F2", "show-stream-info", show_stream_info)
        mp.add_key_binding("F5", "refresh-stream", refresh_stream)
        mp.add_key_binding("Ctrl+F5", "clear-watched", clear_watched)
        mp.add_key_binding("PGDWN", "playlist-next-stream", next_stream)
        mp.add_key_binding("PGUP", "playlist-prev-stream", prev_stream)
        mp.add_key_binding("Alt+k", "auto-start-screen-2", function() auto_start_screen(2) end)
        mp.add_key_binding("Alt+l", "auto-start-screen-1", function() auto_start_screen(1) end)
        
        -- Log key bindings
        local bindings = {
            "F2 -> show-stream-info",
            "F5 -> refresh-stream",
            "Ctrl+F5 -> clear-watched",
            "PGDWN -> playlist-next-stream",
            "PGUP -> playlist-prev-stream",
            "Alt+k -> auto-start-screen-2",
            "Alt+l -> auto-start-screen-1"
        }
        
        for _, binding in ipairs(bindings) do
            msg.debug("Registered key binding: " .. binding)
        end
        
        key_bindings_registered = true
    end
    
    -- Initialize playlist observer
    mp.observe_property("playlist", "native", function(_, playlist)
        if playlist then
            initialize_playlist()
        end
    end)
    
    -- Initialize path observer
    mp.observe_property("path", "string", function(_, path)
        if path and path ~= current_url then
            current_url = path
            initialize_playlist()
        end
    end)
    
    -- Initialize time observer for watched status
    mp.observe_property("time-pos", "number", function(_, time)
        if time and not manual_navigation then
            check_watched_status(time)
        end
    end)
    
    msg.info(string.format("Successfully initialized screen number: %d", script_opts.screen))
end

-- Register script message handlers
mp.register_script_message("log", function(level, message)
    log_to_node(level, message)
end)

-- Start initialization when player is ready
mp.register_event("file-loaded", function()
    if not is_shutting_down then
        init()
    end
end)

-- Cleanup on exit
mp.register_event("shutdown", function()
    is_shutting_down = true
    msg.debug("Exiting...")
end)

-- Update playlist navigation handlers
-- Removed ENTER binding for playlist selection

-- Add handler for playlist-next command
mp.add_key_binding("PGDWN", "playlist-next-stream", function()
    play_next_stream()
end)

-- Add handler for playlist-next command
mp.add_key_binding("END", "playlist-next-stream", function()
    play_next_stream()
end)
-- Add handler for playlist-prev command
mp.add_key_binding("PGUP", "playlist-prev-stream", function()
    local pos = mp.get_property_number("playlist-pos") or 0
    
    if pos > 0 then
        mp.commandv("playlist-prev")
        mp.osd_message("Playing previous stream", 2)
    else
        mp.osd_message("Already at start of playlist", 2)
    end
end)

-- Add a flag to track if we're already playing the next stream
local playing_next_stream = false

-- Improve play_next_stream function to handle network failures
function play_next_stream()
    -- Don't play next stream if we're shutting down
    if is_shutting_down then
        log_to_node("info", "Player is shutting down, not playing next stream")
        return
    end

    -- Prevent infinite loops by checking if we're already playing the next stream
    if playing_next_stream then
        log_to_node("info", "Already playing next stream, not requesting another")
        return
    end

    -- Set the flag to indicate we're playing the next stream
    playing_next_stream = true
    
    -- Set a timeout to reset the flag after 30 seconds in case of failure
    mp.add_timeout(30, function()
        if playing_next_stream then
            msg.warn("Resetting playing_next_stream flag after timeout")
            playing_next_stream = false
        end
    end)
    
    -- Check network connectivity
    local has_network = check_network_connectivity()
    if not has_network then
        msg.warn("No network connectivity detected, keeping player open")
        
        -- Try to play a local file as fallback
        local home_dir = os.getenv("HOME") or os.getenv("USERPROFILE")
        if home_dir then
            local fallback_dirs = {
                home_dir .. "/Videos",
                home_dir .. "/Movies",
                home_dir .. "/Downloads"
            }
            
            for _, dir in ipairs(fallback_dirs) do
                local handle = io.popen('ls -1 "' .. dir .. '" 2>/dev/null | grep -E "\\.(mp4|mkv|avi|mov)$" | head -1')
                if handle then
                    local result = handle:read("*a")
                    handle:close()
                    
                    result = result:gsub("[\n\r]", "")
                    
                    if result and result ~= "" then
                        local file_path = dir .. "/" .. result
                        msg.info("Playing fallback file: " .. file_path)
                        mp.commandv("loadfile", file_path)
                        
                        -- Reset flag after successful fallback
                        mp.add_timeout(3, function()
                            playing_next_stream = false
                        end)
                        return
                    end
                end
            end
        end
        
        -- If no fallback file found, try to reopen the player with a blank playlist
        msg.info("No fallback file found, keeping player open with blank playlist")
        mp.commandv("loadfile", "")
        
        -- Reset flag after reopening
        mp.add_timeout(3, function()
            playing_next_stream = false
        end)
        return
    end

    local screen = get_current_screen()
    if not screen then 
        playing_next_stream = false
        return 
    end
    
    log_to_node("info", "Requesting next stream from API")
    mp.osd_message("Requesting next stream from API", 1)
    
    -- Try first with the next endpoint
    local response = api_request(API.streams.next(screen), "POST", {
        screen = screen
    })
    
    -- If that fails, try the queue endpoint
    if not response or not response.url then
        log_to_node("info", "Next endpoint failed, trying queue endpoint")
        response = http_request(API.streams.queue(screen), "GET")
        
        if response and #response > 0 then
            response = response[1]  -- Take the first item from the queue
        end
    end
    
    if response and response.url then
        log_to_node("info", string.format("Playing next stream: %s", response.url))
        mp.commandv("loadfile", response.url)
        mp.osd_message("Playing next stream", 2)
        
        -- Reset the flag after a delay to allow the new stream to load
        mp.add_timeout(5, function()
            playing_next_stream = false
        end)
    else
        log_to_node("warn", "No next stream available")
        mp.osd_message("No more streams available", 2)
        
        -- Only request new streams if we're not already handling an end-of-playlist event
        if not handling_end_of_playlist then
            -- Request new streams from server
            handle_end_of_playlist()
        else
            log_to_node("info", "Already handling end of playlist, not requesting new streams")
        end
        
        -- Reset the flag since we're done
        playing_next_stream = false
    end
end

-- Helper function to safely read a file
function safe_read_file(path)
    if not path or type(path) ~= "string" then
        msg.error("Invalid file path")
        return nil
    end
    
    local success, file = pcall(io.open, path, "r")
    if not success or not file then
        msg.debug(string.format("Could not open file: %s", path))
        return nil
    end
    
    local content = file:read("*all")
    file:close()
    
    return content
end

-- Helper function to safely write a file
function safe_write_file(path, content)
    if not path or type(path) ~= "string" then
        msg.error("Invalid file path")
        return false
    end
    
    local success, file = pcall(io.open, path, "w")
    if not success or not file then
        msg.error(string.format("Could not open file for writing: %s", path))
        return false
    end
    
    local write_success = pcall(file.write, file, content)
    file:close()
    
    return write_success
end

-- Helper function to safely execute shell commands
function safe_execute(command)
    if not command or type(command) ~= "string" then
        msg.error("Invalid command")
        return nil
    end
    
    local success, result, err = pcall(os.execute, command)
    if not success then
        msg.error(string.format("Command execution failed: %s", err or "unknown error"))
        return nil
    end
    
    return result
end

-- Update cleanup_old_logs function to be safer
function cleanup_old_logs(directory)
    if not directory or type(directory) ~= "string" then
        msg.error("Invalid directory path")
        return
    end
    
    -- Validate directory exists
    local stat = utils.file_info(directory)
    if not stat or not stat.is_dir then
        msg.error(string.format("Invalid log directory: %s", directory))
        return
    end
    
    local max_age_days = 7 -- Default to 7 days
    local cmd = string.format('find %q -name "*.log" -type f -mtime +%d -delete 2>/dev/null', 
        directory, max_age_days)
    
    local success = safe_execute(cmd)
    if success then
        log_to_node("debug", string.format("Cleaned up old logs in %s", directory))
    else
        log_to_node("error", string.format("Failed to clean up logs in %s", directory))
    end
end

-- Update get_log_filename to be safer
function get_log_filename(prefix, screen)
    if not prefix or type(prefix) ~= "string" then
        msg.error("Invalid log prefix")
        return nil
    end
    
    if not screen or type(screen) ~= "number" or screen < 1 then
        msg.error("Invalid screen number for log filename")
        return nil
    end
    
    local timestamp = os.date("%Y%m%d-%H%M%S")
    if not timestamp then
        msg.error("Failed to generate timestamp for log filename")
        return nil
    end
    
    local log_dir = "/home/all/repos/LiveLink/logs/" .. prefix
    
    -- Ensure log directory exists
    local stat = utils.file_info(log_dir)
    if not stat or not stat.is_dir then
        -- Try to create directory
        local success = safe_execute(string.format("mkdir -p %q", log_dir))
        if not success then
            msg.error(string.format("Failed to create log directory: %s", log_dir))
            return nil
        end
    end
    
    return string.format("%s/%s-screen%d-%s.log", 
        log_dir, prefix, screen, timestamp)
end

-- Function to auto-start streams on a specific screen
function auto_start_screen(screen)
    msg.info(string.format("Auto-starting streams on screen %d", screen))
    
    local data = utils.format_json({
        screen = screen
    })
    
    local response = http_request(API.streams.autostart, "POST", nil, data)
    
    if response then
        mp.osd_message(string.format("Auto-starting streams on screen %d", screen), 3)
    else
        mp.osd_message(string.format("Failed to auto-start streams on screen %d", screen), 3)
    end
end

-- Add health check function
function check_process_health()
    if not process_state.starting and not process_state.shutting_down then
        local pid = mp.get_property_number("pid")
        if not pid then
            process_state.error_count = process_state.error_count + 1
            
            if process_state.error_count >= ERROR_RETRY_COUNT then
                show_error("Process appears to be unresponsive", 10)
                request_restart()
            end
        else
            process_state.error_count = 0
            process_state.last_health_check = os.time()
        end
    end
end

-- Add restart request function
function request_restart()
    local screen = get_current_screen()
    if not screen then return end
    
    -- Only request restart if not already in progress
    if not process_state.starting then
        process_state.starting = true
        
        log_to_node("info", "Requesting stream restart")
        
        local data = utils.format_json({
            screen = screen,
            type = "restart"
        })
        
        local response = http_request(API.streams.restart, "POST", nil, data)
        
        if response then
            log_to_node("info", "Restart request sent successfully")
        else
            log_to_node("error", "Failed to send restart request")
            process_state.starting = false
        end
    else
        log_to_node("warn", "Startup already in progress, skipping restart request")
    end
end

-- Add periodic health check timer
mp.add_periodic_timer(5, check_process_health)

-- Update shutdown handler with process state
mp.register_event("shutdown", function()
    if not process_state.shutting_down then
        process_state.shutting_down = true
        log_to_node("info", "MPV shutting down, cleaning up...")
        
        -- Clear active process flag
        active_process = nil
        
        -- Notify the server about shutdown
        local screen = get_current_screen()
        if screen then
            local data = utils.format_json({
                screen = screen,
                type = "shutdown",
                error_count = process_state.error_count
            })
            
            http_request(API.streams.shutdown, "POST", nil, data)
        end
    end
end)

-- Add a flag to track if we're already handling an end-file event
local handling_end_file = false

-- Add end-file event handler with improved logging
mp.register_event("end-file", function(event)
    -- Prevent infinite loops by checking if we're already handling an end-file event
    if handling_end_file then
        log_to_node("info", "Already handling end-file event, not auto-navigating")
        return
    end

    -- Set the flag to indicate we're handling an end-file event
    handling_end_file = true
    
    -- Set a timeout to reset the flag after 30 seconds in case of failure
    mp.add_timeout(30, function()
        if handling_end_file then
            msg.warn("Resetting handling_end_file flag after timeout")
            handling_end_file = false
        end
    end)

    -- Log the event with more details
    log_to_node("info", string.format("Playback ended with reason: %s", event.reason))
    log_to_node("debug", string.format("Current URL: %s", mp.get_property("path") or "none"))
    
    -- Check if this is a manual close (EOF, quit, or error code 4)
    if event.reason == "quit" or event.reason == "eof" or (event.error and event.error:match("code 4")) then
        log_to_node("info", "Player closed manually or reached end of file, not auto-navigating")
        handling_end_file = false
        return
    end
    
    -- Check network connectivity
    local has_network = check_network_connectivity()
    if not has_network then
        msg.warn("No network connectivity detected, keeping player open")
        
        -- Try to play a local file as fallback
        local home_dir = os.getenv("HOME") or os.getenv("USERPROFILE")
        if home_dir then
            local fallback_dirs = {
                home_dir .. "/Videos",
                home_dir .. "/Movies",
                home_dir .. "/Downloads"
            }
            
            for _, dir in ipairs(fallback_dirs) do
                local handle = io.popen('ls -1 "' .. dir .. '" 2>/dev/null | grep -E "\\.(mp4|mkv|avi|mov)$" | head -1')
                if handle then
                    local result = handle:read("*a")
                    handle:close()
                    
                    result = result:gsub("[\n\r]", "")
                    
                    if result and result ~= "" then
                        local file_path = dir .. "/" .. result
                        msg.info("Playing fallback file: " .. file_path)
                        mp.commandv("loadfile", file_path)
                        
                        -- Reset flag after successful fallback
                        mp.add_timeout(3, function()
                            handling_end_file = false
                        end)
                        return
                    end
                end
            end
        end
        
        -- If no fallback file found, try to reopen the player with a blank playlist
        msg.info("No fallback file found, keeping player open with blank playlist")
        mp.commandv("loadfile", "")
        
        -- Reset flag after reopening
        mp.add_timeout(3, function()
            handling_end_file = false
        end)
        return
    end
    
    -- Mark current stream as watched before moving to next
    mark_current_watched()
    
    -- Only handle automatic navigation if not in manual mode
    if not manual_navigation then
        log_to_node("info", "Auto-navigating to next stream")
        -- Add a small delay before playing next stream
        mp.add_timeout(STREAM_SWITCH_DELAY, function()
            play_next_stream()
            -- Reset the flag after playing the next stream
            handling_end_file = false
        end)
    else
        log_to_node("info", "Manual navigation mode - not auto-playing next stream")
        handling_end_file = false
    end
end)

-- Log initialization with more details
log_to_node("info", "LiveLink MPV script initialized")
local screen = get_current_screen()
if screen then
    log_to_node("info", string.format("Running on screen %d", screen))
    -- Log MPV version
    local mpv_version = mp.get_property("mpv-version")
    log_to_node("info", string.format("MPV version: %s", mpv_version))
else
    log_to_node("warn", "Could not determine screen number")
end

-- Initialize screen number early
local initial_screen = get_current_screen()
if initial_screen then
    msg.info("Successfully initialized screen number: " .. initial_screen)
else
    msg.error("Failed to initialize screen number")
end

-- Add playlist control functions
function add_to_playlist(url)
    if not url or type(url) ~= "string" then
        show_error("Invalid URL for playlist")
        return false
    end

    local success, err = pcall(function()
        mp.commandv("loadfile", url, "append")
    end)

    if success then
        log_to_node("info", string.format("Added %s to playlist", url))
        return true
    else
        show_error(string.format("Failed to add %s to playlist", url))
        return false
    end
end

function remove_current_from_playlist()
    local current_pos = mp.get_property_number("playlist-pos")
    if current_pos == nil then
        log_to_node("error", "No current playlist position")
        return false
    end

    local success, err = pcall(function()
        mp.commandv("playlist-remove", "current")
    end)

    if success then
        log_to_node("info", "Removed current item from playlist")
        return true
    else
        log_to_node("error", string.format("Failed to remove current item: %s", err))
        return false
    end
end

function play_playlist_index(index)
    if not index or type(index) ~= "number" then
        show_error("Invalid playlist index")
        return false
    end

    local playlist_count = mp.get_property_number("playlist-count")
    if not playlist_count or index >= playlist_count then
        show_error(string.format("Invalid index %d (playlist size: %d)", 
            index, playlist_count or 0))
        return false
    end

    local success, err = pcall(function()
        mp.commandv("playlist-play-index", tostring(index))
    end)

    if success then
        log_to_node("info", string.format("Playing playlist index %d", index))
        return true
    else
        show_error(string.format("Failed to play index %d", index))
        return false
    end
end

function shuffle_playlist()
    local playlist_count = mp.get_property_number("playlist-count")
    if not playlist_count or playlist_count < 2 then
        log_to_node("warn", "Not enough items to shuffle")
        return false
    end

    local success, err = pcall(function()
        mp.commandv("playlist-shuffle")
    end)

    if success then
        log_to_node("info", "Shuffled playlist")
        return true
    else
        log_to_node("error", string.format("Failed to shuffle playlist: %s", err))
        return false
    end
end

function clear_playlist_except_current()
    local success, err = pcall(function()
        mp.commandv("playlist-clear")
    end)

    if success then
        log_to_node("info", "Cleared playlist except current")
        return true
    else
        log_to_node("error", string.format("Failed to clear playlist: %s", err))
        return false
    end
end

-- Add command handlers for playlist control
mp.register_script_message("playlist-add", function(url)
    add_to_playlist(url)
end)

mp.register_script_message("playlist-remove-current", function()
    remove_current_from_playlist()
end)

mp.register_script_message("playlist-play-index", function(index)
    play_playlist_index(tonumber(index))
end)

mp.register_script_message("playlist-shuffle", function()
    shuffle_playlist()
end)

mp.register_script_message("playlist-clear", function()
    clear_playlist_except_current()
end)

-- Add playlist change observer
mp.observe_property("playlist-count", "number", function(_, count)
    if count then
        local playlist = {}
        for i = 0, count - 1 do
            local item = {
                filename = mp.get_property(string.format("playlist/%d/filename", i)),
                title = mp.get_property(string.format("playlist/%d/title", i)),
                current = (i == mp.get_property_number("playlist-pos"))
            }
            table.insert(playlist, item)
        end
        
        -- Send playlist update to server
        local screen = get_current_screen()
        if screen then
            local data = utils.format_json({
                screen = screen,
                type = "playlist",
                data = playlist
            })
            
            http_request(API.streams.playlist, "POST", nil, data)
        end
    end
end)

-- Add queue loading and management functions
function load_queue()
    if not script_opts.screen then
        show_error("Cannot load queue: screen number not set")
        return false
    end
    
    local response = http_request(API.streams.queue(script_opts.screen), "GET")
    if not response then
        show_error("Failed to load queue from server")
        return false
    end
    
    -- Clear existing playlist
    local success = pcall(function()
        mp.commandv("playlist-clear")
    end)

    if not success then
        show_error("Failed to clear playlist")
        return false
    end
    
    -- Add each queue item to playlist
    local added = 0
    for _, item in ipairs(response) do
        if item.url then
            success = pcall(function()
                mp.commandv("loadfile", item.url, "append")
            end)
            
            if success then
                added = added + 1
            end
        end
    end
    
    log_to_node("info", string.format("Loaded %d items from queue", added))
    return added > 0
end

function remove_watched_streams()
    local screen = get_current_screen()
    if not screen then
        log_to_node("error", "Cannot remove watched streams: screen number not available")
        return false
    end

    -- Get current playlist
    local playlist_count = mp.get_property_number("playlist-count")
    if not playlist_count or playlist_count == 0 then
        log_to_node("info", "No items in playlist")
        return true
    end

    -- Collect indices of watched items (in reverse order)
    local watched_indices = {}
    for i = 0, playlist_count - 1 do
        local filename = mp.get_property(string.format("playlist/%d/filename", i))
        if filename then
            -- Check if URL is in watched list
            local response = http_request(API.streams.watched, "GET")
            
            if response and response[filename] then
                table.insert(watched_indices, 1, i)  -- Insert at beginning for reverse order
            end
        end
    end

    -- Remove watched items (starting from highest index)
    local removed_count = 0
    for _, index in ipairs(watched_indices) do
        local success, err = pcall(function()
            mp.commandv("playlist-remove", tostring(index))
        end)
        
        if success then
            removed_count = removed_count + 1
        else
            log_to_node("error", string.format("Failed to remove playlist item %d: %s", index, err))
        end
    end

    if removed_count > 0 then
        log_to_node("info", string.format("Removed %d watched items from playlist", removed_count))
    end
    
    return true
end

-- Add startup queue loading
mp.register_event("file-loaded", function()
    -- Only load queue if this is the first file
    if mp.get_property_number("playlist-pos") == 0 then
        log_to_node("info", "First file loaded, initializing queue...")
        load_queue()
    end
end)

-- Add periodic check for watched streams
mp.add_periodic_timer(WATCHED_CHECK_INTERVAL, function()
    remove_watched_streams()
end)

-- Add command handler for manual queue reload
mp.register_script_message("reload-queue", function()
    load_queue()
end)

-- Add error display function with better formatting
function show_error(message, duration)
    if not message then return end
    duration = duration or 5
    
    -- Log the error
    msg.error(message)
    
    -- Show error on OSD with better formatting
    local osd_message = string.format("{\\an7}{\\c&H0000FF&}Error: %s", message)
    mp.osd_message(osd_message, duration)
    
    -- Try to send to node
    log_to_node("error", message)
end

-- Update initialization error handling
mp.register_event("start-file", function()
    local screen = get_current_screen()
    if not screen then
        show_error("Failed to initialize: screen number not available", 10)
        return
    end
    
    -- Check for required properties
    local path = mp.get_property("path")
    if not path then
        show_error("Failed to initialize: no media loaded", 10)
        return
    end
    
    -- Initialize playlist if needed
    if mp.get_property_number("playlist-count", 0) == 0 then
        if not load_queue() then
            show_error("Failed to load initial queue", 10)
        end
    end
end)

-- Add the missing check_watched_status function
function check_watched_status(time)
    if not time then return end
    
    local current_url = mp.get_property("path")
    if not current_url then return end
    
    -- Skip if already marked as watched
    if has_value(marked_streams, current_url) then
        return
    end
    
    -- Get duration
    local duration = mp.get_property_number("duration")
    if not duration then return end
    
    -- Mark as watched if:
    -- 1. Watched more than MIN_WATCH_TIME seconds, or
    -- 2. Watched more than 80% of the video
    local watch_threshold = math.min(MIN_WATCH_TIME, duration * 0.8)
    
    if time >= watch_threshold then
        log_to_node("info", string.format("Marking stream as watched: %s (watched %.1f seconds)", 
            current_url, time))
        
        -- Add to local cache
        table.insert(marked_streams, current_url)
        
        -- Send to server
        mark_current_watched()
    end
end