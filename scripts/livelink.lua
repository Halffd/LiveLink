local utils = require 'mp.utils'
local msg = require 'mp.msg'

msg.verbose("LiveLink script starting...")

-- Simple Unix Domain Socket implementation
local UnixSocket = {}
UnixSocket.__index = UnixSocket

function UnixSocket.new()
    msg.debug("Creating new UnixSocket instance")
    local self = setmetatable({}, UnixSocket)
    self.path = nil
    self.file = nil
    return self
end

function UnixSocket:connect(path)
    msg.debug("Attempting to connect to socket at: " .. path)
    self.path = path
    
    -- Check if socket file exists
    local stat = utils.file_info(path)
    if not stat then
        msg.error("Socket file does not exist: " .. path)
        return false, "Socket file does not exist"
    end
    
    msg.debug("Socket file exists, attempting to open")
    -- Open the file for read/write
    local file, err = io.open(path, "r+b")
    if not file then
        msg.error("Failed to open socket: " .. tostring(err))
        return false, err
    end
    
    self.file = file
    msg.debug("Successfully opened socket file")
    return true
end

function UnixSocket:send(data)
    if not self.file then
        msg.warn("Attempted to send data but socket not connected")
        return false, "Socket not connected"
    end
    
    msg.debug("Sending data to socket: " .. data)
    local success, err = pcall(function()
        self.file:write(data)
        self.file:flush()
    end)
    
    if not success then
        msg.error("Failed to write to socket: " .. tostring(err))
        return false, err
    end
    
    msg.debug("Successfully sent data to socket")
    return true
end

function UnixSocket:close()
    msg.debug("Closing socket connection")
    if self.file then
        self.file:close()
        self.file = nil
    end
end

-- State management
local state = {
    screen_id = nil,
    watched_streams = {},
    current_playlist = {},
    stream_info = {
        path = nil,
        title = "Unknown Title",
        duration = 0,
        position = 0,
        remaining = 0,
        playlist_pos = 0,
        playlist_count = 0,
        error_count = 0,
        last_error = nil
    },
    ipc_socket = nil,
    last_update = 0,
    update_interval = 5, -- seconds
    last_error = nil,
    error_count = 0,
    max_errors = 3,
    reconnect_attempts = 0,
    max_reconnect_attempts = 5,
    reconnect_delay = 5, -- seconds
    autostart_attempted = false
}

-- Helper functions
function send_ipc_message(message)
    msg.debug("Preparing to send IPC message: " .. utils.format_json(message))
    if not state.ipc_socket then 
        msg.warn("No IPC socket available, attempting reconnect")
        attempt_reconnect()
        return 
    end
    
    local success, err = state.ipc_socket:send(utils.format_json(message) .. '\n')
    if not success then
        msg.error("Failed to send IPC message: " .. tostring(err))
        attempt_reconnect()
    else
        msg.debug("Successfully sent IPC message")
    end
end

function attempt_reconnect()
    msg.info("Attempting reconnection, attempt " .. state.reconnect_attempts + 1 .. " of " .. state.max_reconnect_attempts)
    if state.reconnect_attempts >= state.max_reconnect_attempts then
        msg.error("Max reconnection attempts reached. Disabling screen.")
        send_error_to_manager("Max reconnection attempts reached")
        return
    end

    state.reconnect_attempts = state.reconnect_attempts + 1
    msg.info("Scheduling reconnect attempt in " .. state.reconnect_delay .. " seconds")
    
    mp.add_timeout(state.reconnect_delay, function()
        connect_to_ipc()
    end)
end

function connect_to_ipc()
    if not state.screen_id then
        msg.error("No screen ID set")
        return false
    end

    local socket_path = string.format("/tmp/mpv-ipc-%d", state.screen_id)
    state.ipc_socket = UnixSocket.new()
    local success, err = state.ipc_socket:connect(socket_path)
    
    if not success then
        msg.error("Failed to connect to IPC socket: " .. tostring(err))
        attempt_reconnect()
        return false
    end
    
    state.reconnect_attempts = 0
    msg.info("Successfully connected to IPC socket")
    return true
end

function send_error_to_manager(error_msg)
    state.last_error = error_msg
    state.error_count = state.error_count + 1
    
    send_ipc_message({
        type = "error",
        screen = state.screen_id,
        error = error_msg,
        count = state.error_count
    })
    
    if state.error_count >= state.max_errors then
        send_ipc_message({
            type = "disable_screen",
            screen = state.screen_id,
            reason = "Too many errors"
        })
    end
end

function update_stream_info()
    local path = mp.get_property("path")
    if not path then return end

    local title = mp.get_property("media-title") or "Unknown Title"
    local duration = mp.get_property_number("duration") or 0
    local position = mp.get_property_number("time-pos") or 0
    local remaining = duration - position
    local playlist_pos = mp.get_property_number("playlist-pos") or 0
    local playlist_count = mp.get_property_number("playlist-count") or 0

    -- Update playlist info whenever we update stream info
    local playlist = mp.get_property_native("playlist") or {}
    if playlist and #playlist > 0 then
        state.current_playlist = playlist
        send_ipc_message({
            type = "playlist_update",
            screen = state.screen_id,
            playlist = playlist
        })
    end

    state.stream_info = {
        path = path,
        title = title,
        duration = duration,
        position = position,
        remaining = remaining,
        playlist_pos = playlist_pos,
        playlist_count = playlist_count,
        error_count = state.error_count,
        last_error = state.last_error
    }

    send_ipc_message({
        type = "stream_info",
        screen = state.screen_id,
        data = state.stream_info
    })
end

function mark_current_watched()
    local path = mp.get_property("path")
    if not path then return end

    -- Only mark as watched if we've watched at least 30 seconds or 20% of the video
    local duration = mp.get_property_number("duration") or 0
    local position = mp.get_property_number("time-pos") or 0
    local threshold = math.min(30, duration * 0.2)
    
    if position >= threshold then
        state.watched_streams[path] = true
        
        send_ipc_message({
            type = "watched",
            screen = state.screen_id,
            url = path
        })

        -- Check if we should move to next stream
        local playlist_count = mp.get_property_number("playlist-count") or 0
        local playlist_pos = mp.get_property_number("playlist-pos") or 0
        
        if playlist_count > 0 and playlist_pos < playlist_count - 1 then
            mp.commandv("playlist-next")
        else
            remove_watched_from_playlist()
        end
    end
end

function remove_watched_from_playlist()
    local playlist = mp.get_property_native("playlist") or {}
    if not playlist or #playlist == 0 then return end

    local new_playlist = {}
    local removed = false
    local current_pos = mp.get_property_number("playlist-pos") or 0

    for i, item in ipairs(playlist) do
        if not state.watched_streams[item.filename] then
            table.insert(new_playlist, item)
        else
            removed = true
            if i <= current_pos then
                current_pos = current_pos - 1
            end
        end
    end

    if removed then
        if #new_playlist == 0 then
            -- If all streams are watched, request new ones
            send_ipc_message({
                type = "all_watched",
                screen = state.screen_id
            })
            return
        end

        mp.set_property_native("playlist", new_playlist)
        if current_pos >= 0 and current_pos < #new_playlist then
            mp.set_property_number("playlist-pos", current_pos)
        end
        state.current_playlist = new_playlist
        
        send_ipc_message({
            type = "playlist_update",
            screen = state.screen_id,
            playlist = new_playlist
        })
    end
end

function show_stream_info()
    local text = string.format(
        "Screen: %s\nTitle: %s\nProgress: %.1f/%.1f\nPlaylist: %d/%d\nWatched: %d streams\nErrors: %d",
        state.screen_id or "Unknown",
        state.stream_info.title or "Unknown",
        state.stream_info.position or 0,
        state.stream_info.duration or 0,
        (state.stream_info.playlist_pos or 0) + 1,
        state.stream_info.playlist_count or 0,
        #state.watched_streams,
        state.error_count
    )
    
    if state.last_error then
        text = text .. "\nLast Error: " .. state.last_error
    end
    
    mp.osd_message(text, 5)
end

function request_stream_update()
    send_ipc_message({
        type = "request_update",
        screen = state.screen_id
    })
    mp.osd_message("Requesting stream update...", 2)
end

function clear_watched_and_update()
    state.watched_streams = {}
    send_ipc_message({
        type = "clear_watched",
        screen = state.screen_id
    })
    request_stream_update()
    mp.osd_message("Cleared watched streams and requesting update...", 2)
end

function toggle_screen()
    send_ipc_message({
        type = "toggle_screen",
        screen = state.screen_id
    })
end

function handle_end_of_playlist()
    send_ipc_message({
        type = "request_update",
        screen = state.screen_id
    })
end

function is_stream_watched(path)
    msg.debug("Checking if stream is watched: " .. path)
    local is_watched = state.watched_streams[path] == true
    msg.debug("Stream watched status: " .. tostring(is_watched))
    return is_watched
end

function find_first_unwatched_stream()
    msg.debug("Searching for first unwatched stream in playlist")
    local playlist = mp.get_property_native("playlist")
    if not playlist then 
        msg.debug("No playlist available")
        return nil 
    end
    
    msg.debug("Playlist size: " .. #playlist)
    for i, item in ipairs(playlist) do
        msg.debug("Checking playlist item " .. i .. ": " .. (item.filename or "unknown"))
        if item.filename and not is_stream_watched(item.filename) then
            msg.debug("Found unwatched stream at position " .. (i-1))
            return i - 1  -- MPV uses 0-based indices
        end
    end
    msg.debug("No unwatched streams found in playlist")
    return nil
end

function attempt_autostart()
    msg.debug("Attempting autostart")
    if state.autostart_attempted then 
        msg.debug("Autostart already attempted, skipping")
        return 
    end
    
    state.autostart_attempted = true
    msg.debug("Looking for first unwatched stream")
    
    local pos = find_first_unwatched_stream()
    if pos then
        msg.info("Starting playback of unwatched stream at position " .. pos)
        mp.set_property("playlist-pos", pos)
        mp.command("playlist-play-index " .. pos)
    else
        msg.debug("No unwatched streams to autostart")
    end
end

function init()
    msg.info("Initializing LiveLink")
    -- Get screen ID from script-opts
    local opts = mp.get_property_native("script-opts")
    msg.debug("Script options: " .. utils.format_json(opts))
    state.screen_id = tonumber(opts.screen)
    
    if not state.screen_id then
        msg.error("No screen ID provided in script-opts")
        return
    end

    msg.info("Initializing LiveLink for screen " .. state.screen_id)

    -- Initialize IPC connection
    if not connect_to_ipc() then
        msg.error("Failed to initialize IPC connection")
        return
    end

    msg.debug("Setting up key bindings")
    -- Set up key bindings
    mp.add_key_binding("F2", "mark_watched", mark_current_watched)
    mp.add_key_binding("F5", "update_streams", request_stream_update)
    mp.add_key_binding("i", "show_stream_info", show_stream_info)
    mp.add_key_binding("t", "toggle_screen", toggle_screen)

    msg.debug("Checking initial playlist")
    -- Initial playlist check and autostart
    local playlist = mp.get_property_native("playlist") or {}
    if playlist and #playlist > 0 then
        msg.debug("Initial playlist has " .. #playlist .. " items")
        state.current_playlist = playlist
        send_ipc_message({
            type = "playlist_update",
            screen = state.screen_id,
            playlist = playlist
        })
        attempt_autostart()
    else
        msg.debug("No initial playlist")
    end

    msg.debug("Setting up event observers")
    -- Set up event handlers
    mp.observe_property("playlist-count", "number", function(_, count)
        msg.debug("Playlist count changed to: " .. (count or "nil"))
        if count and count > 0 then
            -- Send playlist info when count changes
            local playlist = mp.get_property_native("playlist") or {}
            msg.debug("Updated playlist has " .. #playlist .. " items")
            state.current_playlist = playlist
            send_ipc_message({
                type = "playlist_update",
                screen = state.screen_id,
                playlist = playlist
            })
            attempt_autostart()
        elseif count == 0 then
            msg.debug("Playlist is empty, handling end of playlist")
            handle_end_of_playlist()
        end
    end)

    -- Also observe playlist directly for any changes
    mp.observe_property("playlist", "native", function(_, playlist)
        if playlist and #playlist > 0 then
            msg.debug("Playlist content changed, now has " .. #playlist .. " items")
            state.current_playlist = playlist
            send_ipc_message({
                type = "playlist_update",
                screen = state.screen_id,
                playlist = playlist
            })
        end
    end)

    mp.observe_property("path", "string", function(_, path)
        if path then
            msg.debug("Path changed to: " .. path)
            update_stream_info()
        end
    end)

    mp.observe_property("time-pos", "number", function(_, time)
        if time and time > 0 then
            local now = os.time()
            if now - state.last_update >= state.update_interval then
                msg.debug("Updating stream info at position: " .. time)
                update_stream_info()
                state.last_update = now
            end
        end
    end)

    mp.register_event("end-file", function(event)
        msg.debug("File ended with reason: " .. event.reason)
        if event.reason == "eof" then
            msg.debug("End of file reached, marking as watched")
            mark_current_watched()
        elseif event.reason == "stop" then
            msg.debug("Playback stopped manually")
            -- Manual stop - don't automatically proceed
            send_ipc_message({
                type = "player_shutdown",
                screen = state.screen_id,
                manual = true
            })
        end
    end)

    msg.debug("Performing initial stream info update")
    -- Initial update
    update_stream_info()
    msg.info("LiveLink initialization complete")
end

mp.register_event("file-loaded", function()
    msg.debug("File loaded event triggered")
    -- Check playlist when a file is loaded
    local playlist = mp.get_property_native("playlist") or {}
    if playlist and #playlist > 0 then
        msg.debug("Playlist available with " .. #playlist .. " items")
        state.current_playlist = playlist
        send_ipc_message({
            type = "playlist_update",
            screen = state.screen_id,
            playlist = playlist
        })
    end
    update_stream_info()
end)

msg.info("LiveLink script loaded, waiting for start-file event")
-- Initialize when mpv is ready
mp.register_event("start-file", init) 