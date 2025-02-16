local utils = require 'mp.utils'
local msg = require 'mp.msg'
local socket = require 'socket'

-- State management
local state = {
    screen_id = nil,
    watched_streams = {},
    current_playlist = {},
    stream_info = {},
    ipc_socket = nil,
    last_update = 0,
    update_interval = 5, -- seconds
    last_error = nil,
    error_count = 0,
    max_errors = 3,
    reconnect_attempts = 0,
    max_reconnect_attempts = 5,
    reconnect_delay = 5, -- seconds
}

-- Helper functions
function send_ipc_message(message)
    if not state.ipc_socket then 
        attempt_reconnect()
        return 
    end
    
    local success, err = pcall(function()
        state.ipc_socket:send(utils.format_json(message) .. '\n')
    end)
    
    if not success then
        msg.error("Failed to send IPC message: " .. tostring(err))
        attempt_reconnect()
    end
end

function attempt_reconnect()
    if state.reconnect_attempts >= state.max_reconnect_attempts then
        msg.error("Max reconnection attempts reached. Disabling screen.")
        send_error_to_manager("Max reconnection attempts reached")
        return
    end

    state.reconnect_attempts = state.reconnect_attempts + 1
    msg.info("Attempting to reconnect to IPC socket (" .. state.reconnect_attempts .. "/" .. state.max_reconnect_attempts .. ")")
    
    mp.add_timeout(state.reconnect_delay, function()
        connect_to_ipc()
    end)
end

function connect_to_ipc()
    local socket_path = string.format("/tmp/mpv-ipc-%d", state.screen_id)
    state.ipc_socket = socket.unix()
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

    state.watched_streams[path] = true
    
    send_ipc_message({
        type = "watched",
        screen = state.screen_id,
        url = path
    })
end

function remove_watched_from_playlist()
    local playlist = mp.get_property_native("playlist")
    local new_playlist = {}
    local removed = false

    for _, item in ipairs(playlist) do
        if not state.watched_streams[item.filename] then
            table.insert(new_playlist, item)
        else
            removed = true
        end
    end

    if removed then
        mp.set_property_native("playlist", new_playlist)
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
        state.stream_info.playlist_pos + 1 or 0,
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

function toggle_screen(screen_num)
    send_ipc_message({
        type = "toggle_screen",
        screen = screen_num
    })
    mp.osd_message(string.format("Toggling screen %d...", screen_num), 2)
end

-- Event handlers
mp.observe_property("path", "string", function(name, value)
    if value then
        update_stream_info()
    end
end)

mp.observe_property("media-title", "string", function(name, value)
    if value then
        update_stream_info()
    end
end)

mp.observe_property("time-pos", "number", function(name, value)
    if value then
        local now = os.time()
        if now - state.last_update >= state.update_interval then
            update_stream_info()
            state.last_update = now
        end
    end
end)

mp.register_event("end-file", function(event)
    if event.reason == "eof" then
        mark_current_watched()
        remove_watched_from_playlist()
    elseif event.error then
        send_error_to_manager("Playback error: " .. tostring(event.error))
    end
end)

mp.register_event("shutdown", function()
    send_ipc_message({
        type = "player_shutdown",
        screen = state.screen_id
    })
end)

-- Error handling
mp.register_event("error", function(error)
    send_error_to_manager("MPV error: " .. tostring(error))
end)

-- Key bindings
mp.add_key_binding("f2", "show_stream_info", show_stream_info)
mp.add_key_binding("f5", "request_update", request_stream_update)
mp.add_key_binding("Ctrl+f5", "clear_and_update", clear_watched_and_update)
mp.add_key_binding("Shift+f1", "toggle_screen_1", function() toggle_screen(1) end)
mp.add_key_binding("Shift+f2", "toggle_screen_2", function() toggle_screen(2) end)

-- Initialize
function init()
    -- Get screen ID from MPV arguments
    local args = mp.get_property_native("command-line-args")
    for i, arg in ipairs(args) do
        if arg:match("^--screen=") then
            state.screen_id = tonumber(arg:match("--screen=(%d+)"))
            break
        end
    end

    if not state.screen_id then
        msg.error("No screen ID provided")
        return
    end

    if not connect_to_ipc() then
        return
    end

    msg.info("LiveLink plugin initialized for screen " .. state.screen_id)
    request_stream_update()
end

init() 