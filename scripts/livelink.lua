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
local RETRY_DELAY = 2 -- Delay between retries in seconds (reduced from 5)
local STREAM_SWITCH_DELAY = 0.5 -- Delay between switching streams in seconds (reduced from 1)

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

-- Add process state tracking
local process_state = {
    starting = false,
    shutting_down = false,
    last_health_check = os.time(),
    error_count = 0
}

-- Get script options
local options = {
    screen = mp.get_opt("screen")  -- Use mp.get_opt instead of mp.get_script_opts()
}

-- Log script options for debugging
msg.debug("Script options received: " .. utils.format_json(options))

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
        API_URL .. "/log",
        "POST",
        nil,
        message
    )

    return success ~= nil
end

-- Helper function to log with node console and fallback to mpv log
function log_to_node(level, message)
    -- Ensure we have valid parameters
    if type(level) ~= "string" or type(message) ~= "string" then
        msg.error("Invalid parameters to log_to_node")
        return
    end
    
    -- Ensure we have a valid screen number
    local screen = current_screen
    if not screen or type(screen) ~= "number" or screen < 1 then
        screen = 1
        msg.warn("Invalid screen number in log_to_node, using default: 1")
    end

    -- Send log message to server
    local success, error = mp.command_native({
        name = "script-message-to",
        args = {"livelink", "log", level, message}
    })
    
    if not success then
        msg.error(string.format("Failed to send log message: %s", error or "unknown error"))
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

-- Helper function to make HTTP requests with better error handling
function http_request(url, method, headers, data)
    -- Validate input parameters
    if not url or type(url) ~= "string" then
        msg.error("Invalid URL for HTTP request")
        return nil
    end
    
    method = method or "GET"
    if type(method) ~= "string" then
        msg.error("Invalid HTTP method")
        return nil
    end
    
    msg.debug(string.format("Making HTTP request to: %s [%s]", url, method))
    
    -- Build curl command with proper escaping
    local curl_cmd = string.format(
        'curl -s -X %s %s %s %s',
        method,
        string.format("%q", url),
        headers and string.format("-H %q", headers) or "",
        data and string.format("-d %q", data) or ""
    )
    
    -- Execute with error handling
    local success, curl, err = pcall(io.popen, curl_cmd)
    if not success or not curl then
        msg.error(string.format("Failed to execute curl: %s", err or "unknown error"))
        return nil
    end
    
    local response = curl:read('*all')
    local close_success, exit_type, exit_code = curl:close()
    
    if not close_success then
        msg.error(string.format("HTTP request failed with exit code: %s", exit_code))
        return nil
    end
    
    if response and response ~= "" then
        local success, parsed = pcall(utils.parse_json, response)
        if not success or not parsed then
            msg.error("Failed to parse JSON response")
            msg.debug("Raw response: " .. response)
            return nil
        end
        return parsed
    end
    
    return nil
end

-- Get screen number from script options or socket path
function get_current_screen()
    -- First try to get screen from script options
    local screen_opt = mp.get_opt("screen")
    if screen_opt then
        -- Convert to number and validate
        local screen_num = tonumber(screen_opt)
        if screen_num and screen_num > 0 then
            log_to_node("info", string.format("Using screen number %d from script options", screen_num))
            return screen_num
        else
            log_to_node("warn", string.format("Invalid screen number in script options: %s", screen_opt))
        end
    end

    -- Fallback to socket path
    local socket_path = mp.get_property("input-ipc-server")
    if socket_path then
        -- Extract screen number from socket path
        local screen_str = string.match(socket_path, "mpv%-ipc%-(%d+)$")
        if screen_str then
            local screen_num = tonumber(screen_str)
            if screen_num and screen_num > 0 then
                log_to_node("info", string.format("Using screen number %d from socket path", screen_num))
                return screen_num
            else
                log_to_node("warn", string.format("Invalid screen number in socket path: %s", screen_str))
            end
        else
            log_to_node("warn", "Could not extract screen number from socket path: " .. socket_path)
        end
    else
        log_to_node("warn", "No socket path available")
    end

    -- Final fallback to default screen
    log_to_node("warn", "Using default screen number 1")
    return 1
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
    if not screen then
        log_to_node("error", "Cannot handle end of playlist: screen number unknown")
        return
    end
    
    log_to_node("info", string.format("Requesting new streams for screen %d", screen))
    
    -- Request update from server
    local response = http_request(
        API_URL .. "/streams/autostart",
        "POST",
        nil,
        utils.format_json({ screen = screen })
    )
    
    if response and response.success then
        log_to_node("info", "Successfully requested new streams")
        -- Reset playlist initialization flag to allow new initialization
        playlist_initialized = false
        -- Add a small delay before trying to initialize again
        mp.add_timeout(STREAM_SWITCH_DELAY, function()
            initialize_playlist()
        end)
    else
        log_to_node("error", "Failed to request new streams")
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
        
        http_request(
            API_URL .. "/streams/watched",
            "POST",
            nil,
            data
        )
        
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
            nil,
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

-- Update initialize_playlist function
function initialize_playlist()
    -- Return early if already initialized to prevent duplicate initialization
    if playlist_initialized then 
        log_to_node("debug", "Playlist already initialized, skipping")
        return true 
    end
    
    local screen = get_current_screen()
    if not screen then 
        log_to_node("error", "Cannot initialize playlist: screen number unknown")
        return false 
    end
    
    log_to_node("info", string.format("Initializing playlist for screen %d", screen))
    
    -- Clean up old logs before starting new playlist
    local log_dirs = {
        "/home/all/repos/LiveLink/logs/mpv",
        "/home/all/repos/LiveLink/logs/streamlink"
    }
    
    for _, dir in ipairs(log_dirs) do
        cleanup_old_logs(dir)
    end
    
    -- Clear the current playlist first
    mp.commandv("playlist-clear")
    
    -- Fetch queue from API
    local response = http_request(API_URL .. "/streams/queue/" .. screen)
    if response and #response > 0 then
        log_to_node("info", string.format("Found %d streams in queue", #response))
        
        -- Get watched streams to filter
        local watched = http_request(API_URL .. "/streams/watched")
        local watched_urls = watched or {}
        
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
                
                log_to_node("debug", string.format("Adding to playlist: %s", url))
                mp.commandv("loadfile", url, "append")
                added = added + 1
            else
                log_to_node("debug", string.format("Skipping watched stream: %s", stream.url))
            end
        end
        
        log_to_node("info", string.format("Added %d unwatched streams to playlist", added))
        
        if added > 0 then
            -- Start playing the first item if not already playing
            local path = mp.get_property("path")
            if not path then
                log_to_node("info", "Starting playback of first playlist item")
                mp.commandv("playlist-play-index", "0")
            end
            
            playlist_initialized = true
            return true
        else
            log_to_node("warn", "No unwatched streams found in queue")
            -- Request new streams from server
            handle_end_of_playlist()
            return false
        end
    else
        log_to_node("warn", "No streams found in queue")
        -- Request new streams from server
        handle_end_of_playlist()
        playlist_initialized = false  -- Keep false to allow retrying
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

-- Update playlist navigation handlers
-- Removed ENTER binding for playlist selection

-- Add handler for playlist-next command
mp.add_key_binding("PGDWN", "playlist-next-stream", function()
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

-- Update play_next_stream function
function play_next_stream()
    local screen = get_current_screen()
    if not screen then return end

    log_to_node("info", "Requesting next stream from API")
    
    -- Request next stream from API
    local response = http_request(
        API_URL .. "/streams/next/" .. screen,
        "POST",
        nil,
        utils.format_json({ screen = screen })
    )
    
    if response and response.url then
        log_to_node("info", string.format("Playing next stream: %s", response.url))
        mp.commandv("loadfile", response.url)
        mp.osd_message("Playing next stream", 2)
    else
        log_to_node("warn", "No next stream available")
        mp.osd_message("No more streams available", 2)
        -- Request new streams from server
        handle_end_of_playlist()
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
    local stat = mp.utils.file_info(directory)
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
    local stat = mp.utils.file_info(log_dir)
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

-- Register key bindings with proper options and error handling
function setup_key_bindings()
    if key_bindings_registered then
        msg.debug("Key bindings already registered")
        return
    end
    
    -- Unregister existing bindings first
    mp.remove_key_binding("show-stream-info")
    mp.remove_key_binding("refresh-stream")
    mp.remove_key_binding("clear-watched")
    mp.remove_key_binding("playlist-next-stream")
    mp.remove_key_binding("playlist-prev-stream")
    mp.remove_key_binding("auto-start-screen-2")
    mp.remove_key_binding("auto-start-screen-1")

    -- Register direct key bindings with error handling
    local bindings = {
        { key = "F2", name = "show-stream-info", fn = show_stream_info },
        { key = "F5", name = "refresh-stream", fn = refresh_stream },
        { key = "Ctrl+F5", name = "clear-watched", fn = clear_watched },
        { key = "PGDWN", name = "playlist-next-stream", fn = play_next_stream },
        { key = "PGUP", name = "playlist-prev-stream", fn = function()
            local pos = mp.get_property_number("playlist-pos") or 0
            if pos > 0 then
                mp.commandv("playlist-prev")
                mp.osd_message("Playing previous stream", 2)
            else
                mp.osd_message("Already at start of playlist", 2)
            end
        end },
        { key = "Alt+k", name = "auto-start-screen-2", fn = function() auto_start_screen(2) end },
        { key = "Alt+l", name = "auto-start-screen-1", fn = function() auto_start_screen(1) end }
    }

    for _, binding in ipairs(bindings) do
        -- Add error handling wrapper to each function
        local wrapped_fn = function()
            local screen = get_current_screen()
            if not screen then
                msg.error(string.format("Cannot execute %s: screen number unknown", binding.name))
                mp.osd_message(string.format("Error: Screen number unknown", 3))
        return
            end
            binding.fn()
        end

        mp.add_forced_key_binding(binding.key, binding.name, wrapped_fn, { repeatable = false })
        msg.debug(string.format("Registered key binding: %s -> %s", binding.key, binding.name))
    end

    key_bindings_registered = true
    log_to_node("info", "Key bindings registered successfully")
end

-- Update on_load hook to ensure key bindings are set up
mp.add_hook("on_load", 50, function()
    local url = mp.get_property("path")
    if not url then return end
    
    -- Reset process state
    process_state.starting = false
    process_state.error_count = 0
    process_state.last_health_check = os.time()
    
    log_to_node("info", string.format("Loading URL: %s", url))
    
    -- Clean up old logs
    local log_dirs = {
        "/home/all/repos/LiveLink/logs/mpv",
        "/home/all/repos/LiveLink/logs/streamlink"
    }
    
    for _, dir in ipairs(log_dirs) do
        cleanup_old_logs(dir)
    end
    
    -- Setup key bindings if not already set
    if not key_bindings_registered then
        setup_key_bindings()
    end
    
    -- Check if this URL is already playing on another screen
    local is_duplicate, other_screen = check_url_duplicate(url)
    if is_duplicate then
        log_to_node("warn", string.format("URL already playing on screen %d, skipping", other_screen))
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

-- Add health check function
function check_process_health()
    if not process_state.starting and not process_state.shutting_down then
        local pid = mp.get_property_number("pid")
        if not pid then
            process_state.error_count = process_state.error_count + 1
            log_to_node("warn", string.format("Process health check failed (%d/%d)", 
                process_state.error_count, ERROR_RETRY_COUNT))
            
            if process_state.error_count >= ERROR_RETRY_COUNT then
                log_to_node("error", "Process appears to be unresponsive, requesting restart")
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
        
        local response = http_request(
            API_URL .. "/streams/restart",
            "POST",
            nil,
            data
        )
        
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
            
            http_request(
                API_URL .. "/streams/shutdown",
                "POST",
                nil,
                data
            )
        end
    end
end)

-- Add end-file event handler with improved logging
mp.register_event("end-file", function(event)
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

-- Log initialization with more details
log_to_node("info", "LiveLink MPV script initialized")
local screen = get_current_screen()
if screen then
    log_to_node("info", string.format("Running on screen %d", screen))
    -- Log MPV version and key bindings
    local mpv_version = mp.get_property("mpv-version")
    log_to_node("info", string.format("MPV version: %s", mpv_version))
    -- Setup initial key bindings
    setup_key_bindings()
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
        log_to_node("error", "Invalid URL for playlist addition")
        return false
    end

    local success, err = pcall(function()
        mp.commandv("loadfile", url, "append")
    end)

    if success then
        log_to_node("info", string.format("Added %s to playlist", url))
        return true
    else
        log_to_node("error", string.format("Failed to add %s to playlist: %s", url, err))
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
        log_to_node("error", "Invalid playlist index")
        return false
    end

    local playlist_count = mp.get_property_number("playlist-count")
    if not playlist_count or index >= playlist_count then
        log_to_node("error", string.format("Invalid index %d for playlist of size %d", 
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
        log_to_node("error", string.format("Failed to play index %d: %s", index, err))
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
            
            http_request(
                API_URL .. "/streams/playlist",
                "POST",
                nil,
                data
            )
        end
    end
end)

-- Add queue loading and management functions
function load_queue_from_server()
    local screen = get_current_screen()
    if not screen then
        log_to_node("error", "Cannot load queue: screen number not available")
        return false
    end

    -- Request queue from server
    local response = http_request(
        API_URL .. "/streams/queue/" .. screen,
        "GET"
    )

    if not response then
        log_to_node("error", "Failed to fetch queue from server")
        return false
    end

    -- Clear existing playlist first
    local success, err = pcall(function()
        mp.commandv("playlist-clear")
    end)

    if not success then
        log_to_node("error", string.format("Failed to clear playlist: %s", err))
        return false
    end

    -- Add each queue item to playlist
    local added_count = 0
    for _, item in ipairs(response) do
        if item.url then
            local add_success = add_to_playlist(item.url)
            if add_success then
                added_count = added_count + 1
            end
        end
    end

    log_to_node("info", string.format("Loaded %d items from queue", added_count))
    return true
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
            local response = http_request(
                API_URL .. "/streams/watched",
                "GET"
            )
            
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
        load_queue_from_server()
    end
end)

-- Add periodic check for watched streams
local WATCHED_CHECK_INTERVAL = 60  -- Check every minute
mp.add_periodic_timer(WATCHED_CHECK_INTERVAL, function()
    remove_watched_streams()
end)

-- Add command handler for manual queue reload
mp.register_script_message("reload-queue", function()
    load_queue_from_server()
end)