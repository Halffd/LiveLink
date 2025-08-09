@src/types/stream_instance.ts
@src/types/stream.ts
@src/types/config.ts
@src/server/routes/*.ts
@src/cli/*.ts
@src/server/*.ts
@src/server/services/*.ts

2025-08-09T03:09:33.631Z INFO  [Logger] Logger initialized
2025-08-09T03:09:34.007Z INFO  [QueueService] QueueService initialized
2025-08-09T03:09:34.008Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/favorites.json
2025-08-09T03:09:34.009Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/streams.json
2025-08-09T03:09:34.009Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/player.json
2025-08-09T03:09:34.010Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/mpv.json
2025-08-09T03:09:34.010Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/streamlink.json
2025-08-09T03:09:34.010Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/filters.json
2025-08-09T03:09:34.011Z INFO  [ConfigLoader] Config loaded
2025-08-09T03:09:34.012Z INFO  [HolodexService] Holodex service initialized
2025-08-09T03:09:34.013Z INFO  [TwitchService] Twitch service initialized
2025-08-09T03:09:34.018Z INFO  [KeyboardService] Keyboard service initializing...
2025-08-09T03:09:34.018Z INFO  [StreamManager] Initialized 2 screen configurations
2025-08-09T03:09:34.019Z INFO  [StreamManager] Stream state machines initialized
2025-08-09T03:09:34.019Z INFO  [StreamManager] Event listeners set up
2025-08-09T03:09:34.019Z INFO  [StreamManager] Updating queues for 2 screens
2025-08-09T03:09:34.020Z INFO  [StreamManager] StreamManager initialized
2025-08-09T03:09:34.024Z INFO  [Server] Auto-starting streams...
2025-08-09T03:09:34.024Z INFO  [StreamManager] Auto-starting streams...
2025-08-09T03:09:34.024Z INFO  [StreamManager] Auto-starting streams for screens: 1, 2
2025-08-09T03:09:34.025Z INFO  [StreamManager] Fetching fresh stream data...
2025-08-09T03:09:34.109Z INFO  [StreamManager] Fetching streams for screen 1
2025-08-09T03:09:34.111Z INFO  [StreamManager] Fetching streams for screen 2
2025-08-09T03:09:34.785Z INFO  [KeyboardService] Keyboard service initialized successfully
2025-08-09T03:09:36.201Z INFO  [TwitchService] Found 12 Twitch streams
2025-08-09T03:09:36.206Z INFO  [TwitchService] Found 12 Twitch streams
2025-08-09T03:09:36.425Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:36.486Z INFO  [HolodexService] Found 4 live streams
2025-08-09T03:09:36.491Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:36.506Z INFO  [HolodexService] Found 9 live streams
2025-08-09T03:09:36.692Z INFO  [HolodexService] Found 45 live streams
2025-08-09T03:09:36.694Z INFO  [HolodexService] Found 2 live streams
2025-08-09T03:09:36.924Z INFO  [HolodexService] Found 4 live streams
2025-08-09T03:09:36.925Z INFO  [QueueService] Queue updated for screen 2. Size: 16
2025-08-09T03:09:36.925Z INFO  [StreamManager] Updated queue for screen 2: 16 streams
2025-08-09T03:09:36.925Z INFO  [StreamManager] Starting stream on screen 2: https://twitch.tv/henyathegenius
2025-08-09T03:09:36.926Z INFO  [StreamManager] Screen 2 state transition: idle -> starting
2025-08-09T03:09:36.926Z INFO  [PlayerService] Attempting to start stream on screen 2: https://twitch.tv/henyathegenius
2025-08-09T03:09:36.926Z INFO  [PlayerService] Checking if screen is disabled for screen 2
2025-08-09T03:09:36.927Z INFO  [PlayerService] Active streams: 0
2025-08-09T03:09:36.927Z INFO  [PlayerService] Checking for maximum streams limit for screen 2
2025-08-09T03:09:36.927Z INFO  [PlayerService] Checking startup lock for screen 2
2025-08-09T03:09:36.927Z INFO  [PlayerService] Set startup lock for screen 2
2025-08-09T03:09:36.927Z INFO  [PlayerService] Stopping stream on screen 2, manual=false, force=false
2025-08-09T03:09:36.927Z INFO  [PlayerService] Starting stream with title: 📛life is pain dayo / !tts / !game / !discord / !vod / !fanbox /, viewers: 5283, time: 1754693462000, screen: 2
2025-08-09T03:09:36.987Z INFO  [PlayerService] Using MPV at: mpv
2025-08-09T03:09:36.987Z INFO  [PlayerService] Starting Streamlink for screen 2
2025-08-09T03:09:36.988Z INFO  [PlayerService] MPV args for screen 2: --border=no --border=no --input-ipc-server=/home/half-arch/.livelink/mpv-ipc-2 --config-dir=/home/all/repos/LiveLink/scripts/mpv --log-file=/home/all/repos/LiveLink/logs/screen_2.log --geometry=1366x768+0+312 --volume=50 --msg-level=all=debug --window-maximized=yes
2025-08-09T03:09:37.020Z INFO  [PlayerService] Streamlink args: streamlink https://twitch.tv/henyathegenius best --player mpv --player mpv --default-stream best --stream-timeout 60 --player-no-close --twitch-disable-hosting --twitch-disable-ads --twitch-low-latency --retry-max 5 --retry-streams 5 --ringbuffer-size 128M --player-continuous-http --stream-segment-attempts 5 --player-args --border=no --border=no --input-ipc-server=/home/half-arch/.livelink/mpv-ipc-2 --config-dir=/home/all/repos/LiveLink/scripts/mpv --log-file=/home/all/repos/LiveLink/logs/screen_2.log --geometry=1366x768+0+312 --volume=50 --msg-level=all=debug --window-maximized=yes
2025-08-09T03:09:37.023Z INFO  [PlayerService] Streamlink logs will be written to: /home/all/repos/LiveLink/logs/streamlink-screen-2-20250809-000937.log
2025-08-09T03:09:37.373Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:37.379Z INFO  [HolodexService] Found 2 live streams
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T03:09:37.409Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 1 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos: live
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 1 videos
2025-08-09T03:09:37.410Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos: live
2025-08-09T03:09:37.411Z INFO  [HolodexService] Found 2 live streams from 17 channels
2025-08-09T03:09:37.417Z INFO  [HolodexService] Found 3 live streams
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T03:09:37.425Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T03:09:37.426Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 1 videos
2025-08-09T03:09:37.427Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos: live
2025-08-09T03:09:37.427Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 1 videos
2025-08-09T03:09:37.427Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos: live
2025-08-09T03:09:37.427Z INFO  [HolodexService] Found 2 live streams from 17 channels
2025-08-09T03:09:37.449Z INFO  [HolodexService] Found 4 live streams
2025-08-09T03:09:37.454Z INFO  [HolodexService] Found 3 live streams
2025-08-09T03:09:37.455Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:37.455Z INFO  [StreamManager] Fetched 86 streams from all sources
2025-08-09T03:09:37.455Z INFO  [StreamManager] Fetched 86 live streams for initialization
2025-08-09T03:09:37.456Z INFO  [QueueService] Queue updated for screen 1. Size: 68
2025-08-09T03:09:37.456Z INFO  [StreamManager] Initialized queue for screen 1 with 68 streams
2025-08-09T03:09:37.456Z INFO  [StreamManager] Starting initial stream on screen 1: https://youtube.com/watch?v=5jFSxDzPTCE
2025-08-09T03:09:37.456Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=5jFSxDzPTCE
2025-08-09T03:09:37.816Z INFO  [HolodexService] Found 2 live streams
2025-08-09T03:09:37.831Z INFO  [PlayerService] Streamlink output: [session][info] Plugin twitch is being overridden by /home/half-arch/.local/share/streamlink/plugins/twitch.py (sha256:7a677cbe8f1ed8e8f070cdaae1839dd19829803ee5eec4ff48510c9dcf688d61)

2025-08-09T03:09:37.833Z INFO  [PlayerService] Streamlink output: [cli][info] Found matching plugin twitch for URL https://twitch.tv/henyathegenius

2025-08-09T03:09:37.833Z INFO  [PlayerService] Streamlink output: [warnings][streamlinkdeprecation] The --twitch-disable-ads plugin argument has been disabled and will be removed in the future
[warnings][streamlinkdeprecation] The --twitch-disable-hosting plugin argument has been disabled and will be removed in the future

2025-08-09T03:09:37.833Z INFO  [PlayerService] Streamlink output: [plugins.twitch][info] streamlink-ttvlol 7.5.0-20250709 (7.5.0)

2025-08-09T03:09:37.834Z INFO  [PlayerService] Streamlink output: [plugins.twitch][info] Please report issues to https://github.com/2bc4/streamlink-ttvlol/issues

2025-08-09T03:09:37.835Z INFO  [PlayerService] Streamlink output: [plugins.twitch][info] Using playlist proxy 'https://lb-eu3.cdn-perfprod.com'

2025-08-09T03:09:38.026Z INFO  [HolodexService] Found 3 live streams
2025-08-09T03:09:38.237Z INFO  [HolodexService] Found 2 live streams
2025-08-09T03:09:38.448Z INFO  [HolodexService] Found 9 live streams
2025-08-09T03:09:38.662Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:38.870Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:39.077Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:39.285Z INFO  [HolodexService] Found 3 live streams
2025-08-09T03:09:39.493Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:39.703Z INFO  [HolodexService] Found 4 live streams
2025-08-09T03:09:40.106Z INFO  [HolodexService] Found 45 live streams
2025-08-09T03:09:40.106Z INFO  [QueueService] Queue updated for screen 1. Size: 70
2025-08-09T03:09:40.106Z INFO  [StreamManager] Updated queue for screen 1: 70 streams
2025-08-09T03:09:40.106Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=krhop9Ko9FY
2025-08-09T03:09:40.106Z INFO  [StreamManager] Screen 1 state transition: idle -> starting
2025-08-09T03:09:40.107Z INFO  [PlayerService] Attempting to start stream on screen 1: https://youtube.com/watch?v=5jFSxDzPTCE
2025-08-09T03:09:40.107Z INFO  [PlayerService] Checking if screen is disabled for screen 1
2025-08-09T03:09:40.107Z INFO  [PlayerService] Active streams: 0
2025-08-09T03:09:40.107Z INFO  [PlayerService] Checking for maximum streams limit for screen 1
2025-08-09T03:09:40.107Z INFO  [PlayerService] Checking startup lock for screen 1
2025-08-09T03:09:40.107Z WARN  [PlayerService] Found stuck startup lock for screen 2, clearing it
2025-08-09T03:09:40.107Z INFO  [PlayerService] Set startup lock for screen 1
2025-08-09T03:09:40.108Z INFO  [PlayerService] Stopping stream on screen 1, manual=false, force=false
2025-08-09T03:09:40.108Z INFO  [PlayerService] Starting stream with title: pippa finds out Frank Sinatra was a movie star || Suddenly (1954), viewers: 2105, time: 1754701196000, screen: 1
2025-08-09T03:09:40.108Z INFO  [StreamManager] Queue updates started with 1 minute interval
2025-08-09T03:09:40.133Z INFO  [PlayerService] Using MPV at: mpv
2025-08-09T03:09:40.134Z INFO  [PlayerService] Starting MPV for screen 1
2025-08-09T03:09:40.134Z INFO  [PlayerService] Starting MPV for screen 1
2025-08-09T03:09:40.137Z INFO  [PlayerService] MPV args for screen 1: --border=no --border=no --input-ipc-server=/home/half-arch/.livelink/mpv-ipc-1 --config-dir=/home/all/repos/LiveLink/scripts/mpv --log-file=/home/all/repos/LiveLink/logs/screen_1.log --geometry=1920x1080+1366+0 --volume=0 --msg-level=all=debug --window-maximized=yes https://youtube.com/watch?v=5jFSxDzPTCE
2025-08-09T03:09:40.138Z INFO  [PlayerService] MPV logs will be written to: /home/all/repos/LiveLink/logs/mpv-screen-1-20250809-000940.log
2025-08-09T03:09:43.146Z INFO  [PlayerService] Player process started with PID 643353 for screen 1
2025-08-09T03:09:44.149Z INFO  [PlayerService] Stream started successfully on screen 1 with PID 643353
2025-08-09T03:09:44.149Z INFO  [StreamManager] Screen 1 state transition: starting -> playing
2025-08-09T03:09:44.149Z WARN  [StreamManager] Invalid state transition for screen 1: playing -> starting
2025-08-09T03:09:44.149Z INFO  [QueueService] Queue updated for screen 2. Size: 14
2025-08-09T03:09:44.150Z INFO  [StreamManager] Initialized queue for screen 2 with 14 streams
2025-08-09T03:09:44.150Z INFO  [StreamManager] Starting initial stream on screen 2: https://twitch.tv/henyathegenius
2025-08-09T03:09:44.150Z INFO  [StreamManager] Starting stream on screen 2: https://twitch.tv/henyathegenius
2025-08-09T03:09:44.150Z ERROR [StreamManager] Failed to start next stream on screen 1: Could not transition to STARTING state
2025-08-09T03:09:44.150Z INFO  [StreamManager] Screen 1 state transition: playing -> error
2025-08-09T03:09:44.150Z ERROR [StreamManager] Screen 1 entered ERROR state: Could not transition to STARTING state
2025-08-09T03:09:44.150Z INFO  [QueueService] Queue updated for screen 1. Size: 68
2025-08-09T03:09:44.352Z INFO  [PlayerService] Stopping stream on screen 1 (https://youtube.com/watch?v=5jFSxDzPTCE), manual=false, force=true
2025-08-09T03:09:44.353Z INFO  [PlayerService] Stopping stream on screen 1 (automatic)
2025-08-09T03:09:44.362Z INFO  [PlayerService] Cleaning up resources for screen 1
2025-08-09T03:09:44.363Z INFO  [PlayerService] Cleanup complete for screen 1. Remaining active streams: 0/2 -
2025-08-09T03:09:44.364Z INFO  [StreamManager] Marking stream as watched: https://youtube.com/watch?v=5jFSxDzPTCE
2025-08-09T03:09:44.365Z INFO  Cleared active stream reference for https://youtube.com/watch?v=5jFSxDzPTCE on screen 1
2025-08-09T03:09:44.365Z INFO  [StreamManager] Removed watched stream https://youtube.com/watch?v=5jFSxDzPTCE from queue for screen 1
2025-08-09T03:09:44.368Z INFO  [StreamManager] Marked ended stream as watched: https://youtube.com/watch?v=5jFSxDzPTCE
2025-08-09T03:09:44.368Z INFO  [StreamManager] Fetching streams for screen 1
2025-08-09T03:09:44.926Z ERROR [StreamManager] Error in withLock for screen 2 during startStream (startStream_1754708976925_zh0b88trd): Operation startStream timed out after 8000ms
2025-08-09T03:09:44.927Z INFO  [PlayerService] Attempting to start stream on screen 2: https://twitch.tv/henyathegenius
2025-08-09T03:09:44.927Z INFO  [PlayerService] Checking if screen is disabled for screen 2
2025-08-09T03:09:44.927Z INFO  [PlayerService] Active streams: 0
2025-08-09T03:09:44.927Z INFO  [PlayerService] Checking for maximum streams limit for screen 2
2025-08-09T03:09:44.927Z INFO  [PlayerService] Checking startup lock for screen 2
2025-08-09T03:09:44.927Z INFO  [PlayerService] Set startup lock for screen 2
2025-08-09T03:09:44.927Z INFO  [PlayerService] Stopping stream on screen 2, manual=false, force=false
2025-08-09T03:09:44.927Z ERROR [StreamManager] Error starting next stream on screen 2
Error: Operation startStream timed out after 8000ms
    at Timeout._onTimeout (file:///home/all/repos/LiveLink/dist/server/stream_manager.js:266:32)
    at listOnTimeout (node:internal/timers:608:17)
    at process.processTimers (node:internal/timers:543:7)
2025-08-09T03:09:44.930Z INFO  [StreamManager] Screen 2 state transition: starting -> error
2025-08-09T03:09:44.930Z INFO  [PlayerService] Starting stream with title: 📛life is pain dayo / !tts / !game / !discord / !vod / !fanbox /, viewers: 5283, time: 1754693462000, screen: 2
2025-08-09T03:09:44.930Z ERROR [StreamManager] Screen 2 entered ERROR state: Operation startStream timed out after 8000ms
2025-08-09T03:09:44.946Z INFO  [PlayerService] Using MPV at: mpv
2025-08-09T03:09:44.946Z INFO  [PlayerService] Starting Streamlink for screen 2
2025-08-09T03:09:44.946Z INFO  [PlayerService] MPV args for screen 2: --border=no --border=no --input-ipc-server=/home/half-arch/.livelink/mpv-ipc-2 --config-dir=/home/all/repos/LiveLink/scripts/mpv --log-file=/home/all/repos/LiveLink/logs/screen_2.log --geometry=1366x768+0+312 --volume=0 --msg-level=all=debug --window-maximized=yes
2025-08-09T03:09:44.947Z INFO  [PlayerService] Streamlink args: streamlink https://twitch.tv/henyathegenius best --player mpv --player mpv --default-stream best --stream-timeout 60 --player-no-close --twitch-disable-hosting --twitch-disable-ads --twitch-low-latency --retry-max 5 --retry-streams 5 --ringbuffer-size 128M --player-continuous-http --stream-segment-attempts 5 --player-args --border=no --border=no --input-ipc-server=/home/half-arch/.livelink/mpv-ipc-2 --config-dir=/home/all/repos/LiveLink/scripts/mpv --log-file=/home/all/repos/LiveLink/logs/screen_2.log --geometry=1366x768+0+312 --volume=0 --msg-level=all=debug --window-maximized=yes
2025-08-09T03:09:44.947Z INFO  [PlayerService] Streamlink logs will be written to: /home/all/repos/LiveLink/logs/streamlink-screen-2-20250809-000944.log
2025-08-09T03:09:45.238Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T03:09:45.238Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T03:09:45.238Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T03:09:45.238Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T03:09:45.238Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T03:09:45.239Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T03:09:45.240Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 1 videos
2025-08-09T03:09:45.240Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos: live
2025-08-09T03:09:45.240Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 1 videos
2025-08-09T03:09:45.240Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos: live
2025-08-09T03:09:45.240Z INFO  [HolodexService] Found 2 live streams from 17 channels
2025-08-09T03:09:45.505Z INFO  [PlayerService] Streamlink output: [session][info] Plugin twitch is being overridden by /home/half-arch/.local/share/streamlink/plugins/twitch.py (sha256:7a677cbe8f1ed8e8f070cdaae1839dd19829803ee5eec4ff48510c9dcf688d61)

2025-08-09T03:09:45.507Z INFO  [PlayerService] Streamlink output: [cli][info] Found matching plugin twitch for URL https://twitch.tv/henyathegenius
[warnings][streamlinkdeprecation] The --twitch-disable-ads plugin argument has been disabled and will be removed in the future
[warnings][streamlinkdeprecation] The --twitch-disable-hosting plugin argument has been disabled and will be removed in the future

2025-08-09T03:09:45.508Z INFO  [PlayerService] Streamlink output: [plugins.twitch][info] streamlink-ttvlol 7.5.0-20250709 (7.5.0)
[plugins.twitch][info] Please report issues to https://github.com/2bc4/streamlink-ttvlol/issues

2025-08-09T03:09:45.512Z INFO  [PlayerService] Streamlink output: [plugins.twitch][info] Using playlist proxy 'https://lb-eu3.cdn-perfprod.com'

2025-08-09T03:09:45.641Z INFO  [HolodexService] Found 2 live streams
2025-08-09T03:09:45.851Z INFO  [HolodexService] Found 3 live streams
2025-08-09T03:09:46.058Z INFO  [HolodexService] Found 2 live streams
2025-08-09T03:09:46.266Z INFO  [HolodexService] Found 9 live streams
2025-08-09T03:09:46.473Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:46.679Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:46.889Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:47.099Z INFO  [HolodexService] Found 3 live streams
2025-08-09T03:09:47.302Z INFO  [HolodexService] Found 0 live streams
2025-08-09T03:09:47.519Z INFO  [HolodexService] Found 4 live streams
2025-08-09T03:09:47.933Z INFO  [HolodexService] Found 45 live streams
2025-08-09T03:09:47.934Z INFO  [QueueService] Queue updated for screen 1. Size: 68
2025-08-09T03:09:47.934Z INFO  [StreamManager] Updated queue for screen 1: 68 streams
2025-08-09T03:09:47.934Z INFO  [StreamManager] Screen 1 state transition: error -> idle
2025-08-09T03:09:47.934Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=krhop9Ko9FY
2025-08-09T03:09:52.159Z ERROR [StreamManager] Error during auto-start: Timeout
2025-08-09T03:09:52.159Z INFO  [Server] Auto-start complete
2025-08-09T03:09:52.165Z INFO  [Server] Server running on http://localhost:3001
2025-08-09T03:09:52.165Z INFO  [Server] Routes:
2025-08-09T03:09:52.165Z INFO  [Server] HEAD,GET /api/organizations
2025-08-09T03:09:52.166Z INFO  [Server] HEAD,GET /api/streams/active
2025-08-09T03:09:52.167Z INFO  [Server] HEAD,GET /api/streams/vtubers
2025-08-09T03:09:52.167Z INFO  [Server] HEAD,GET /api/streams/japanese
2025-08-09T03:09:52.167Z INFO  [Server] HEAD,GET /api/streams
2025-08-09T03:09:52.167Z INFO  [Server] POST /api/streams/start
2025-08-09T03:09:52.167Z INFO  [Server] DELETE /api/streams/:screen
2025-08-09T03:09:52.167Z INFO  [Server] POST /api/screens/:screen/disable
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/screens/:screen/enable
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/url
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/restart
2025-08-09T03:09:52.168Z INFO  [Server] HEAD,GET /api/streams/queue/:screen
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/queue/:screen
2025-08-09T03:09:52.168Z INFO  [Server] DELETE /api/streams/queue/:screen/:index
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/reorder
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/start/:screen
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/stop/:screen
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/player/priority
2025-08-09T03:09:52.168Z INFO  [Server] HEAD,GET /api/streams/watched
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/streams/watched
2025-08-09T03:09:52.168Z INFO  [Server] DELETE /api/streams/watched
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/server/stop
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/server/stop-all
2025-08-09T03:09:52.168Z INFO  [Server] POST /api/player/command/:screen
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/player/command/all
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/player/volume/:target
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/player/pause/:target
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/player/seek/:target
2025-08-09T03:09:52.169Z INFO  [Server] HEAD,GET /api/player/settings
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/player/settings
2025-08-09T03:09:52.169Z INFO  [Server] HEAD,GET /api/screens
2025-08-09T03:09:52.169Z INFO  [Server] PUT /api/screens/:screen
2025-08-09T03:09:52.169Z INFO  [Server] HEAD,GET /api/config
2025-08-09T03:09:52.169Z INFO  [Server] PUT /api/config
2025-08-09T03:09:52.169Z INFO  [Server] HEAD,GET /screens/:screen
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/streams/autostart
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/streams/close-all
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/log
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/streams/playlist
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/streams/refresh
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/streams/refresh/:screen
2025-08-09T03:09:52.169Z INFO  [Server] HEAD,GET /api/server/status
2025-08-09T03:09:52.169Z INFO  [Server] POST /screens/:screen/toggle
2025-08-09T03:09:52.169Z INFO  [Server] POST /screens/new-player
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/screens/:screen/toggle
2025-08-09T03:09:52.169Z INFO  [Server] POST /api/screens/:screen/new-player
2025-08-09T03:09:52.170Z INFO  [Server] HEAD,GET /streams/:screen/details
2025-08-09T03:09:52.170Z INFO  [Server] HEAD,GET /streams/queue/:screen
2025-08-09T03:09:52.170Z INFO  [Server] POST /streams/queue/:screen/refresh
2025-08-09T03:09:52.170Z INFO  [Server] HEAD,GET /screens/:screen
2025-08-09T03:09:52.170Z INFO  [Server] POST /streams/manual-start
2025-08-09T03:09:52.170Z INFO  [Server] POST /streams/force-refresh-all
2025-08-09T03:09:52.170Z INFO  [Server] POST /api/streams/add-test-stream
2025-08-09T03:09:52.170Z INFO  [Server] HEAD,GET /streams/diagnostics
2025-08-09T03:09:52.354Z ERROR [StreamManager] Error in withLock for screen 1 during handleStreamEnd (handleStreamEnd_1754708984352_pktzrlnrr): Operation handleStreamEnd timed out after 8000ms
2025-08-09T03:09:52.354Z INFO  [StreamManager] Screen 1 state transition: idle -> starting
2025-08-09T03:09:52.354Z INFO  [PlayerService] Attempting to start stream on screen 1: https://youtube.com/watch?v=krhop9Ko9FY
2025-08-09T03:09:52.354Z INFO  [PlayerService] Checking if screen is disabled for screen 1
2025-08-09T03:09:52.354Z INFO  [PlayerService] Active streams: 0
2025-08-09T03:09:52.354Z INFO  [PlayerService] Checking for maximum streams limit for screen 1
2025-08-09T03:09:52.354Z INFO  [PlayerService] Checking startup lock for screen 1
2025-08-09T03:09:52.355Z WARN  [PlayerService] Found stuck startup lock for screen 2, clearing it
2025-08-09T03:09:52.355Z INFO  [PlayerService] Set startup lock for screen 1
2025-08-09T03:09:52.355Z INFO  [PlayerService] Stopping stream on screen 1, manual=false, force=false
2025-08-09T03:09:52.355Z INFO  [PlayerService] Starting stream with title: 【CHATTING】Got invited to Marvel Rivals Studio【Dokibird】, viewers: 2712, time: 1754703264000, screen: 1

Fix it exiting/crashing during execution, fix the errors in above log, ensure multiple streams never start on same screen, while making it fast and robust with no big delays
