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

    msg.debug("Checking for duplicate stream: " .. url)
    
    local response = http_request(API_URL .. "/streams/active")
    if response then
        for _, stream in ipairs(response) do
            if stream.url == url and stream.screen ~= get_current_screen() then
                msg.warn(string.format("URL already playing on screen %d", stream.screen))
                return true, stream.screen
            end
        end
    end
    
    msg.debug("No duplicates found")
    return false, nil
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
    
    -- Only update if URL has changed
    if url ~= current_url then
        msg.info("URL changed, updating stream info")
        
        local is_duplicate, other_screen = check_url_duplicate(url)
        if is_duplicate then
            msg.warn(string.format("URL already playing on screen %d, stopping", other_screen))
            mp.command("quit")
            return
        end
        
        current_url = url
        
        -- Update screen info via API
        local data = utils.format_json({
            url = url,
            screen = screen,
            quality = mp.get_property("options/quality") or "best"
        })
        
        msg.debug("Sending update to API: " .. data)
        
        -- Only send update, don't process response
        http_request(
            API_URL .. "/streams/url",
            "POST",
            nil,
            data
        )
        
        msg.info("Stream info update sent")
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

-- Mark current stream as watched
function mark_watched()
    local url = mp.get_property("path")
    local screen = get_current_screen()
    if url and screen then
        -- Skip if already marked
        if marked_streams[url] then
            msg.debug("Stream already marked as watched: " .. url)
            return
        end
        
        msg.info("Marking as watched: " .. url)
        
        -- Skip marking playlist files as watched
        if string.match(url, "playlist%-screen%d+") then
            msg.debug("Skipping playlist file")
            return
        end
        
        -- Add stream to watched list via API
        local data = utils.format_json({
            url = url,
            screen = screen
        })
        
        local response = http_request(
            API_URL .. "/streams/watched",
            "POST",
            nil,
            data
        )
        
        if response then
            msg.info("Stream marked as watched")
            marked_streams[url] = true
        else
            msg.error("Failed to mark stream as watched")
        end
    end
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

-- Play next stream from queue
function play_next_stream()
    local screen = get_current_screen()
    if not screen then return end

    msg.info("Attempting to play next stream")
    
    -- Get playlist info
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local playlist_count = mp.get_property_number("playlist-count") or 0
    
    msg.debug(string.format("Current playlist position: %d/%d", playlist_pos + 1, playlist_count))
    
    -- If we have more items in playlist, let MPV handle it
    if playlist_pos + 1 < playlist_count then
        msg.info("Using MPV playlist to play next stream")
        mp.commandv("playlist-next")
    else
        msg.info("Playlist ended, no more streams available")
        mp.osd_message("No more streams in playlist", 3)
    end
end

-- Register event handlers
mp.register_event("file-loaded", function()
    msg.info("File loaded event triggered")
    local url = mp.get_property("path")
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local playlist_count = mp.get_property_number("playlist-count") or 0
    
    msg.debug(string.format("File loaded: %s (playlist pos: %d/%d)", 
        url or "nil",
        playlist_pos + 1,
        playlist_count))
    
    -- Skip playlist files
    if not string.match(url, "playlist%-screen%d+") then
        msg.debug(string.format("Processing URL: %s", url))
        update_screen_info()
        -- Mark as watched on startup
        mark_watched()
    else
        msg.debug("Skipping playlist file processing")
    end
end)

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