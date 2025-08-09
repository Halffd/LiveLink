@src/types/stream_instance.ts
@src/types/stream.ts
@src/types/config.ts
@src/server/routes/*.ts
@src/server/stream_manager.ts
@src/server/services/player.ts
@tree src
2025-08-09T05:03:49.889Z INFO  [Logger] Logger initialized
2025-08-09T05:03:50.224Z INFO  [QueueService] QueueService initialized
2025-08-09T05:03:50.226Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/favorites.json
2025-08-09T05:03:50.226Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/streams.json
2025-08-09T05:03:50.227Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/player.json
2025-08-09T05:03:50.227Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/mpv.json
2025-08-09T05:03:50.227Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/streamlink.json
2025-08-09T05:03:50.227Z INFO  [ConfigLoader] Loading config file: /home/all/repos/LiveLink/src/config/default/filters.json
2025-08-09T05:03:50.228Z INFO  [ConfigLoader] Config loaded
2025-08-09T05:03:50.229Z INFO  [HolodexService] Holodex service initialized
2025-08-09T05:03:50.230Z INFO  [TwitchService] Twitch service initialized
2025-08-09T05:03:50.233Z INFO  [KeyboardService] Keyboard service initializing...
2025-08-09T05:03:50.233Z INFO  [StreamManager] Initialized 2 screen configurations
2025-08-09T05:03:50.234Z INFO  [StreamManager] Stream state machines initialized
2025-08-09T05:03:50.234Z INFO  [StreamManager] Event listeners set up
2025-08-09T05:03:50.234Z INFO  [StreamManager] Updating queues for 2 screens
2025-08-09T05:03:50.234Z INFO  [StreamManager] StreamManager initialized
2025-08-09T05:03:50.239Z INFO  [Server] Auto-starting streams...
2025-08-09T05:03:50.239Z INFO  [StreamManager] Auto-starting streams...
2025-08-09T05:03:50.239Z INFO  [StreamManager] Auto-starting streams for screens: 1, 2
2025-08-09T05:03:50.239Z INFO  [StreamManager] Fetching fresh stream data...
2025-08-09T05:03:50.284Z INFO  [StreamManager] Fetching streams for screen 1
2025-08-09T05:03:50.291Z INFO  [StreamManager] Fetching streams for screen 2
2025-08-09T05:03:50.415Z ERROR [TwitchService] Failed to fetch batch of streams: request to https://id.twitch.tv/oauth2/token?grant_type=client_credentials&client_id=wtl7mwep6n5o1bgcpr0m1v6kae38ia&client_secret=f4rkji0woysvs7zd79ex5c4ijp951a failed, reason:
2025-08-09T05:03:50.415Z ERROR [TwitchService] Failed to fetch batch of streams: request to https://id.twitch.tv/oauth2/token?grant_type=client_credentials&client_id=wtl7mwep6n5o1bgcpr0m1v6kae38ia&client_secret=f4rkji0woysvs7zd79ex5c4ijp951a failed, reason:
2025-08-09T05:03:50.415Z ERROR [TwitchService] Failed to fetch batch of streams: request to https://id.twitch.tv/oauth2/token?grant_type=client_credentials&client_id=wtl7mwep6n5o1bgcpr0m1v6kae38ia&client_secret=f4rkji0woysvs7zd79ex5c4ijp951a failed, reason:
2025-08-09T05:03:50.415Z ERROR [TwitchService] Failed to fetch batch of streams: request to https://id.twitch.tv/oauth2/token?grant_type=client_credentials&client_id=wtl7mwep6n5o1bgcpr0m1v6kae38ia&client_secret=f4rkji0woysvs7zd79ex5c4ijp951a failed, reason:
2025-08-09T05:03:50.416Z INFO  [TwitchService] Found 0 Twitch streams
2025-08-09T05:03:50.416Z INFO  [TwitchService] Found 0 Twitch streams
2025-08-09T05:03:50.564Z INFO  [KeyboardService] Keyboard service initialized successfully
2025-08-09T05:03:51.938Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:03:51.972Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.972Z INFO  [StreamManager] No streams found for screen 2, queue will be empty
2025-08-09T05:03:51.979Z ERROR [HolodexService] Failed to fetch videos for channel UCLIpj4TmXviSTNE_U5WG_Ug
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.980Z ERROR [HolodexService] Failed to fetch videos for channel UCrV1Hf5r8P148idjoSfrGEQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.988Z ERROR [HolodexService] Failed to fetch videos for channel UCJ46YTYBQVXsfsp8-HryoUA
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.989Z ERROR [HolodexService] Failed to fetch videos for channel UC5CwaMl1eIgY8h02uZw7u8A
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.990Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.994Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.995Z ERROR [HolodexService] Failed to fetch videos for channel UComInW10MkHJs-_vi4rHQCQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.996Z ERROR [HolodexService] Failed to fetch videos for channel UCt30jJgChL8qeT9VPadidSw
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.996Z ERROR [HolodexService] Failed to fetch videos for channel UCrV1Hf5r8P148idjoSfrGEQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:51.999Z ERROR [HolodexService] Failed to fetch videos for channel UComInW10MkHJs-_vi4rHQCQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.007Z ERROR [HolodexService] Failed to fetch videos for channel UClS3cnIUM9yzsBPQzeyX_8Q
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.014Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.015Z ERROR [HolodexService] Failed to fetch videos for channel UCYiIgZVotTS9K3eb7nine0g
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.016Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.018Z ERROR [HolodexService] Failed to fetch videos for channel UCxsZ6NCzjU_t4YSxQLBcM5A
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.019Z ERROR [HolodexService] Failed to fetch videos for channel UC4WvIIAo89_AzGUh1AZ6Dkg
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.019Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.022Z ERROR [HolodexService] Failed to fetch videos for channel UCIfAvpeIWGHb0duCkMkmm2Q
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.031Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.034Z ERROR [HolodexService] Failed to fetch videos for channel UC5CwaMl1eIgY8h02uZw7u8A
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.035Z ERROR [HolodexService] Failed to fetch videos for channel UCLIpj4TmXviSTNE_U5WG_Ug
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.038Z ERROR [HolodexService] Failed to fetch videos for channel UC54JqsuIbMw_d1Ieb4hjKoQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.051Z ERROR [HolodexService] Failed to fetch videos for channel UC6T7TJZbW6nO-qsc5coo8Pg
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.054Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.055Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.066Z ERROR [HolodexService] Failed to fetch videos for channel UCcHHkJ98eSfa5aj0mdTwwLQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.071Z ERROR [HolodexService] Failed to fetch videos for channel UC7YXqPO3eUnxbJ6rN0z2z1Q
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.074Z ERROR [HolodexService] Error fetching live streams from Holodex
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.075Z ERROR [HolodexService] Failed to fetch videos for channel UCJ46YTYBQVXsfsp8-HryoUA
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.078Z ERROR [HolodexService] Failed to fetch videos for channel UClS3cnIUM9yzsBPQzeyX_8Q
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T05:03:52.161Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 1 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos: live
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T05:03:52.162Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 0 videos
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos:
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 0 videos
2025-08-09T05:03:52.163Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos:
2025-08-09T05:03:52.163Z INFO  [HolodexService] Found 1 live streams from 17 channels
2025-08-09T05:03:52.208Z INFO  [HolodexService] Found 2 live streams
2025-08-09T05:03:52.290Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 1 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos: live
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T05:03:52.291Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 0 videos
2025-08-09T05:03:52.292Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos:
2025-08-09T05:03:52.292Z INFO  [HolodexService] Found 1 live streams from 17 channels
2025-08-09T05:03:52.691Z INFO  [HolodexService] Found 6 live streams
2025-08-09T05:03:52.705Z INFO  [HolodexService] Found 4 live streams
2025-08-09T05:03:52.706Z INFO  [StreamManager] Fetched 7 streams from all sources
2025-08-09T05:03:52.706Z INFO  [StreamManager] Fetched 7 live streams for initialization
2025-08-09T05:03:52.897Z INFO  [HolodexService] Found 3 live streams
2025-08-09T05:03:53.879Z INFO  [HolodexService] Found 1 live streams
2025-08-09T05:03:54.085Z INFO  [HolodexService] Found 7 live streams
2025-08-09T05:03:54.294Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:03:54.498Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:03:54.703Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:03:54.908Z INFO  [HolodexService] Found 4 live streams
2025-08-09T05:03:55.115Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:03:55.319Z INFO  [HolodexService] Found 2 live streams
2025-08-09T05:03:55.722Z INFO  [HolodexService] Found 45 live streams
2025-08-09T05:03:55.723Z INFO  [QueueService] Queue updated for screen 1. Size: 69
2025-08-09T05:03:55.724Z INFO  [StreamManager] Updated queue for screen 1: 69 streams
2025-08-09T05:03:55.724Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=tLtNtJrI-U4
2025-08-09T05:03:55.724Z INFO  [QueueService] Queue updated for screen 1. Size: 6
2025-08-09T05:03:55.725Z INFO  [StreamManager] Initialized queue for screen 1 with 6 streams
2025-08-09T05:03:55.725Z INFO  [StreamManager] Starting initial stream on screen 1: https://youtube.com/watch?v=tLtNtJrI-U4
2025-08-09T05:03:55.725Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=tLtNtJrI-U4
2025-08-09T05:03:55.725Z INFO  [StreamManager] Queue updates started with 1 minute interval
2025-08-09T05:04:10.727Z WARN  [StreamManager] Timeout acquiring lock for screen 1 during startStream (startStream_1754715835724_1l4y49dd6)
2025-08-09T05:04:10.727Z ERROR [StreamManager] Error starting next stream on screen 1
Error: Mutex acquire timeout after 15000ms - lock held by autoStartScreen
    at Timeout._onTimeout (file:///home/all/repos/LiveLink/dist/server/utils/mutex.js:72:24)
    at listOnTimeout (node:internal/timers:608:17)
    at process.processTimers (node:internal/timers:543:7)
2025-08-09T05:04:10.728Z INFO  [StreamManager] Screen 1 state transition: idle -> error
2025-08-09T05:04:10.728Z ERROR [StreamManager] Screen 1 entered ERROR state: Mutex acquire timeout after 15000ms - lock held by autoStartScreen
2025-08-09T05:04:10.728Z WARN  [StreamManager] Timeout acquiring lock for screen 1 during startStream (startStream_1754715835725_nz3uza5cn)
2025-08-09T05:04:10.728Z WARN  [StreamManager] Timeout acquiring lock for screen 1 during autoStartScreen (autoStartScreen_1754715832706_dxt04yzu7)
2025-08-09T05:04:10.729Z INFO  [PlayerService] Stopping stream on screen 1, manual=false, force=true
2025-08-09T05:04:10.729Z ERROR [StreamManager] Error during auto-start: Mutex acquire timeout after 15000ms - lock held by autoStartScreen
2025-08-09T05:04:10.729Z INFO  [StreamManager] Fetching streams for screen 1
2025-08-09T05:04:10.730Z INFO  [Server] Auto-start complete
2025-08-09T05:04:10.775Z INFO  [Server] Server running on http://localhost:3001
2025-08-09T05:04:10.775Z INFO  [Server] Routes:
2025-08-09T05:04:10.776Z INFO  [Server] HEAD,GET /api/organizations
2025-08-09T05:04:10.776Z INFO  [Server] HEAD,GET /api/streams/active
2025-08-09T05:04:10.776Z INFO  [Server] HEAD,GET /api/streams/vtubers
2025-08-09T05:04:10.776Z INFO  [Server] HEAD,GET /api/streams/japanese
2025-08-09T05:04:10.777Z INFO  [Server] HEAD,GET /api/streams
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/start
2025-08-09T05:04:10.777Z INFO  [Server] DELETE /api/streams/:screen
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/screens/:screen/disable
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/screens/:screen/enable
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/url
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/restart
2025-08-09T05:04:10.777Z INFO  [Server] HEAD,GET /api/streams/queue/:screen
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/queue/:screen
2025-08-09T05:04:10.777Z INFO  [Server] DELETE /api/streams/queue/:screen/:index
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/reorder
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/start/:screen
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/streams/stop/:screen
2025-08-09T05:04:10.777Z INFO  [Server] POST /api/player/priority
2025-08-09T05:04:10.777Z INFO  [Server] HEAD,GET /api/streams/watched
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/streams/watched
2025-08-09T05:04:10.778Z INFO  [Server] DELETE /api/streams/watched
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/server/stop
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/server/stop-all
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/player/command/:screen
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/player/command/all
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/player/volume/:target
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/player/pause/:target
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/player/seek/:target
2025-08-09T05:04:10.778Z INFO  [Server] HEAD,GET /api/player/settings
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/player/settings
2025-08-09T05:04:10.778Z INFO  [Server] HEAD,GET /api/screens
2025-08-09T05:04:10.778Z INFO  [Server] PUT /api/screens/:screen
2025-08-09T05:04:10.778Z INFO  [Server] HEAD,GET /api/config
2025-08-09T05:04:10.778Z INFO  [Server] PUT /api/config
2025-08-09T05:04:10.778Z INFO  [Server] HEAD,GET /screens/:screen
2025-08-09T05:04:10.778Z INFO  [Server] POST /api/streams/autostart
2025-08-09T05:04:10.779Z INFO  [Server] POST /api/streams/close-all
2025-08-09T05:04:10.779Z INFO  [Server] POST /api/log
2025-08-09T05:04:10.779Z INFO  [Server] POST /api/streams/playlist
2025-08-09T05:04:10.779Z INFO  [Server] POST /api/streams/refresh
2025-08-09T05:04:10.779Z INFO  [Server] POST /api/streams/refresh/:screen
2025-08-09T05:04:10.779Z INFO  [Server] HEAD,GET /api/server/status
2025-08-09T05:04:10.786Z INFO  [Server] POST /screens/:screen/toggle
2025-08-09T05:04:10.786Z INFO  [Server] POST /screens/new-player
2025-08-09T05:04:10.786Z INFO  [Server] POST /api/screens/:screen/toggle
2025-08-09T05:04:10.786Z INFO  [Server] POST /api/screens/:screen/new-player
2025-08-09T05:04:10.786Z INFO  [Server] HEAD,GET /streams/:screen/details
2025-08-09T05:04:10.786Z INFO  [Server] HEAD,GET /streams/queue/:screen
2025-08-09T05:04:10.786Z INFO  [Server] POST /streams/queue/:screen/refresh
2025-08-09T05:04:10.786Z INFO  [Server] HEAD,GET /screens/:screen
2025-08-09T05:04:10.786Z INFO  [Server] POST /streams/manual-start
2025-08-09T05:04:10.786Z INFO  [Server] POST /streams/force-refresh-all
2025-08-09T05:04:10.786Z INFO  [Server] POST /api/streams/add-test-stream
2025-08-09T05:04:10.786Z INFO  [Server] HEAD,GET /streams/diagnostics
2025-08-09T05:04:12.398Z ERROR [HolodexService] Failed to fetch videos for channel UC5CwaMl1eIgY8h02uZw7u8A
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.402Z ERROR [HolodexService] Failed to fetch videos for channel UCYiIgZVotTS9K3eb7nine0g
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.422Z ERROR [HolodexService] Failed to fetch videos for channel UCrV1Hf5r8P148idjoSfrGEQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.458Z ERROR [HolodexService] Failed to fetch videos for channel UCIfAvpeIWGHb0duCkMkmm2Q
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.462Z ERROR [HolodexService] Failed to fetch videos for channel UCxsZ6NCzjU_t4YSxQLBcM5A
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.470Z ERROR [HolodexService] Failed to fetch videos for channel UCnn1Pb_JtyHbiDTELf7mgSA
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.487Z ERROR [HolodexService] Failed to fetch videos for channel UC4WvIIAo89_AzGUh1AZ6Dkg
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.490Z ERROR [HolodexService] Failed to fetch videos for channel UC3K7pmiHsNSx1y0tdx2bbCw
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.498Z ERROR [HolodexService] Failed to fetch videos for channel UC54JqsuIbMw_d1Ieb4hjKoQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.499Z ERROR [HolodexService] Failed to fetch videos for channel UC6T7TJZbW6nO-qsc5coo8Pg
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.522Z ERROR [HolodexService] Failed to fetch videos for channel UCt30jJgChL8qeT9VPadidSw
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.542Z ERROR [HolodexService] Failed to fetch videos for channel UCcHHkJ98eSfa5aj0mdTwwLQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:12.581Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T05:04:12.581Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T05:04:12.581Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T05:04:12.581Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T05:04:12.581Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T05:04:12.581Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos:
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 0 videos
2025-08-09T05:04:12.582Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos:
2025-08-09T05:04:12.583Z INFO  [HolodexService] Found 0 live streams from 17 channels
2025-08-09T05:04:12.984Z INFO  [HolodexService] Found 6 live streams
2025-08-09T05:04:13.995Z INFO  [HolodexService] Found 3 live streams
2025-08-09T05:04:14.203Z INFO  [HolodexService] Found 1 live streams
2025-08-09T05:04:14.414Z INFO  [HolodexService] Found 7 live streams
2025-08-09T05:04:14.620Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:14.826Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:15.029Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:15.234Z INFO  [HolodexService] Found 4 live streams
2025-08-09T05:04:15.490Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:15.694Z INFO  [HolodexService] Found 2 live streams
2025-08-09T05:04:16.097Z INFO  [HolodexService] Found 45 live streams
2025-08-09T05:04:16.097Z INFO  [QueueService] Queue updated for screen 1. Size: 68
2025-08-09T05:04:16.098Z INFO  [StreamManager] Updated queue for screen 1: 68 streams
2025-08-09T05:04:16.098Z INFO  [StreamManager] Screen 1 state transition: error -> idle
2025-08-09T05:04:16.098Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=4XojVqihboU
2025-08-09T05:04:25.749Z ERROR [StreamManager] Error in withLock for screen 1 during handleStreamEnd (handleStreamEnd_1754715850728_ufuex793o): Operation handleStreamEnd timed out after 15000ms
2025-08-09T05:04:25.753Z INFO  [StreamManager] Screen 1 state transition: idle -> starting
2025-08-09T05:04:25.753Z INFO  [PlayerService] Attempting to start stream on screen 1: https://youtube.com/watch?v=4XojVqihboU
2025-08-09T05:04:25.753Z INFO  [PlayerService] Checking if screen is disabled for screen 1
2025-08-09T05:04:25.753Z INFO  [PlayerService] Active streams: 0
2025-08-09T05:04:25.753Z INFO  [PlayerService] Checking for maximum streams limit for screen 1
2025-08-09T05:04:25.754Z INFO  [PlayerService] Checking startup lock for screen 1
2025-08-09T05:04:25.754Z INFO  [PlayerService] Set startup lock for screen 1
2025-08-09T05:04:25.754Z INFO  [PlayerService] Starting stream with title: 【# 生スバル】ナルティメットストーム!やるしゅばあああああああああああああああああああ!!!!：NARUTO-ナルト- 疾風伝 ナルティメットストームトリロジー【ネタバレあり】, viewers: 21797, time: 1754712150000, screen: 1
2025-08-09T05:04:25.754Z ERROR [StreamManager] Failed to start stream on screen 1: Operation handleStreamEnd timed out after 15000ms
Error: Operation handleStreamEnd timed out after 15000ms
    at Timeout._onTimeout (file:///home/all/repos/LiveLink/dist/server/stream_manager.js:266:32)
    at listOnTimeout (node:internal/timers:608:17)
    at process.processTimers (node:internal/timers:543:7)
2025-08-09T05:04:25.774Z INFO  [PlayerService] Using MPV at: mpv
2025-08-09T05:04:25.774Z INFO  [PlayerService] Starting MPV for screen 1
2025-08-09T05:04:25.775Z INFO  [PlayerService] Starting MPV for screen 1
2025-08-09T05:04:25.775Z INFO  [PlayerService] MPV args for screen 1: --border=no --border=no --input-ipc-server=/home/half-arch/.livelink/mpv-ipc-1 --config-dir=/home/all/repos/LiveLink/scripts/mpv --log-file=/home/all/repos/LiveLink/logs/screen_1.log --geometry=1920x1080+1366+0 --volume=50 --msg-level=all=debug --window-maximized=yes https://youtube.com/watch?v=4XojVqihboU
2025-08-09T05:04:25.777Z INFO  [PlayerService] MPV logs will be written to: /home/all/repos/LiveLink/logs/mpv-screen-1-20250809-020425.log
2025-08-09T05:04:28.781Z INFO  [PlayerService] Player process started with PID 835598 for screen 1
2025-08-09T05:04:29.783Z ERROR [PlayerService] Failed to start stream on screen 1: https://youtube.com/watch?v=4XojVqihboU
Error: Player process exited immediately after starting (PID: 835598)
    at PlayerService.startStream (file:///home/all/repos/LiveLink/dist/server/services/player.js:286:27)
    at async safeAsync.screen.screen (file:///home/all/repos/LiveLink/dist/server/stream_manager.js:751:32)
    at async safeAsync (file:///home/all/repos/LiveLink/dist/server/utils/async_helpers.js:10:16)
    at async StreamManager.withLock (file:///home/all/repos/LiveLink/dist/server/stream_manager.js:258:20)
    at async StreamManager.startNextStream (file:///home/all/repos/LiveLink/dist/server/stream_manager.js:609:33)
    at async file:///home/all/repos/LiveLink/dist/server/stream_manager.js:565:21
2025-08-09T05:04:29.784Z INFO  [StreamManager] Screen 1 state transition: starting -> error
2025-08-09T05:04:29.784Z ERROR [StreamManager] Screen 1 entered ERROR state: Player process exited immediately after starting (PID: 835598)
2025-08-09T05:04:29.784Z ERROR [StreamManager] Failed to start next stream on screen 1: Player process exited immediately after starting (PID: 835598)
2025-08-09T05:04:29.784Z INFO  [QueueService] Queue updated for screen 1. Size: 67
2025-08-09T05:04:29.986Z INFO  [PlayerService] Stopping stream on screen 1, manual=false, force=true
2025-08-09T05:04:29.986Z INFO  [StreamManager] Fetching streams for screen 1
2025-08-09T05:04:31.670Z ERROR [HolodexService] Failed to fetch videos for channel UCYiIgZVotTS9K3eb7nine0g
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:31.685Z ERROR [HolodexService] Failed to fetch videos for channel UClS3cnIUM9yzsBPQzeyX_8Q
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:31.694Z ERROR [HolodexService] Failed to fetch videos for channel UCrV1Hf5r8P148idjoSfrGEQ
AggregateError [EHOSTUNREACH]:
    at internalConnectMultiple (node:net:1139:18)
    at internalConnectMultiple (node:net:1215:5)
    at afterConnectMultiple (node:net:1714:7)
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCxsZ6NCzjU_t4YSxQLBcM5A videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC5CwaMl1eIgY8h02uZw7u8A videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCLIpj4TmXviSTNE_U5WG_Ug videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC54JqsuIbMw_d1Ieb4hjKoQ videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCIfAvpeIWGHb0duCkMkmm2Q videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC6T7TJZbW6nO-qsc5coo8Pg videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA returned 1 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCnn1Pb_JtyHbiDTELf7mgSA videos: live
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCrV1Hf5r8P148idjoSfrGEQ videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC7YXqPO3eUnxbJ6rN0z2z1Q videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UClS3cnIUM9yzsBPQzeyX_8Q videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg returned 0 videos
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UC4WvIIAo89_AzGUh1AZ6Dkg videos:
2025-08-09T05:04:31.835Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw returned 0 videos
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCt30jJgChL8qeT9VPadidSw videos:
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw returned 0 videos
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UC3K7pmiHsNSx1y0tdx2bbCw videos:
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ returned 0 videos
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCcHHkJ98eSfa5aj0mdTwwLQ videos:
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g returned 0 videos
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCYiIgZVotTS9K3eb7nine0g videos:
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA returned 0 videos
2025-08-09T05:04:31.836Z INFO  [HolodexService] Channel UCJ46YTYBQVXsfsp8-HryoUA videos:
2025-08-09T05:04:31.837Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ returned 0 videos
2025-08-09T05:04:31.837Z INFO  [HolodexService] Channel UComInW10MkHJs-_vi4rHQCQ videos:
2025-08-09T05:04:31.837Z INFO  [HolodexService] Found 1 live streams from 17 channels
2025-08-09T05:04:32.310Z INFO  [HolodexService] Found 6 live streams
2025-08-09T05:04:32.634Z INFO  [HolodexService] Found 3 live streams
2025-08-09T05:04:32.891Z INFO  [HolodexService] Found 2 live streams
2025-08-09T05:04:33.755Z INFO  [HolodexService] Found 7 live streams
2025-08-09T05:04:34.051Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:34.307Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:34.566Z INFO  [HolodexService] Found 1 live streams
2025-08-09T05:04:34.836Z INFO  [HolodexService] Found 4 live streams
2025-08-09T05:04:35.039Z INFO  [HolodexService] Found 0 live streams
2025-08-09T05:04:35.295Z INFO  [HolodexService] Found 2 live streams
2025-08-09T05:04:35.768Z INFO  [HolodexService] Found 45 live streams
2025-08-09T05:04:35.769Z INFO  [QueueService] Queue updated for screen 1. Size: 71
2025-08-09T05:04:35.769Z INFO  [StreamManager] Updated queue for screen 1: 71 streams
2025-08-09T05:04:35.769Z INFO  [StreamManager] Screen 1 state transition: error -> idle
2025-08-09T05:04:35.769Z INFO  [StreamManager] Starting stream on screen 1: https://youtube.com/watch?v=tLtNtJrI-U4
2025-08-09T05:04:45.007Z ERROR [StreamManager] Error in withLock for screen 1 during handleStreamEnd (handleStreamEnd_1754715869986_ihfwg5fwm): Operation handleStreamEnd timed out after 15000ms
2025-08-09T05:04:45.007Z INFO  [StreamManager] Screen 1 state transition: idle -> starting
2025-08-09T05:04:45.007Z INFO  [PlayerService] Attempting to start stream on screen 1: https://youtube.com/watch?v=tLtNtJrI-U4
2025-08-09T05:04:45.007Z INFO  [PlayerService] Checking if screen is disabled for screen 1
2025-08-09T05:04:45.007Z INFO  [PlayerService] Active streams: 0
2025-08-09T05:04:45.007Z INFO  [PlayerService] Checking for maximum streams limit for screen 1
2025-08-09T05:04:45.007Z INFO  [PlayerService] Checking startup lock for screen 1
2025-08-09T05:04:45.007Z INFO  [PlayerService] Set startup lock for screen 1
2025-08-09T05:04:45.008Z INFO  [PlayerService] Starting stream with title: 【つぐのひ-彁名縛りの部屋-】怖いの苦手系VTuberの初ホラーゲーム実況 |新人VTuber悠針 れい  #ゆうばりタイム, viewers: 3293, time: 1754711941000, screen: 1

Fix it exiting apruptally during execution, fix the errors in above log, ensure multiple streams never start on same screen, while making it fast and robust with no big delays
