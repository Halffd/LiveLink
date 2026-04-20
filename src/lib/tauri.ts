import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export interface AppInfo {
    name: string;
    version: string;
    description: string;
}

export interface SystemRequirements {
    mpv: boolean;
    streamlink: boolean;
}

export interface AppConfig {
    streams: StreamConfig[];
    mpv: MpvConfig;
    streamlink: StreamlinkConfig;
    favorites?: FavoritesConfig;
}

export interface StreamConfig {
    id: number;
    screen: number;
    enabled: boolean;
    width: number;
    height: number;
    x: number;
    y: number;
    volume: number;
    quality: string;
}

export interface MpvConfig {
    priority: string;
    'gpu-context': string;
}

export interface StreamlinkConfig {
    path: string;
    options: Record<string, unknown>;
}

export interface FavoritesConfig {
    holodex: PlatformFavorites;
    twitch: PlatformFavorites;
    youtube: PlatformFavorites;
}

export interface PlatformFavorites {
    default: FavoriteChannel[];
}

export interface FavoriteChannel {
    id: string;
    name: string;
    score: number;
}

export async function getAppInfo(): Promise<AppInfo> {
    return invoke<AppInfo>('get_app_info');
}

export async function checkSystemRequirements(): Promise<SystemRequirements> {
    return invoke<SystemRequirements>('check_system_requirements');
}

export async function minimizeWindow(): Promise<void> {
    const window = getCurrentWindow();
    await window.minimize();
}

export async function maximizeWindow(): Promise<void> {
    const window = getCurrentWindow();
    const isMaximized = await window.isMaximized();
    if (isMaximized) {
        await window.unmaximize();
    } else {
        await window.maximize();
    }
}

export async function closeWindow(): Promise<void> {
    const window = getCurrentWindow();
    await window.close();
}

export async function hideWindow(): Promise<void> {
    await invoke('window_hide');
}

export async function showWindow(): Promise<void> {
    await invoke('window_show');
}

export async function toggleFullscreen(): Promise<boolean> {
    return invoke<boolean>('window_toggle_fullscreen');
}

export async function readConfig(): Promise<AppConfig> {
    return invoke<AppConfig>('read_config');
}

export async function writeConfig(config: AppConfig): Promise<void> {
    return invoke<void>('write_config', { config });
}

export async function getConfigPath(): Promise<string> {
    return invoke<string>('get_config_path');
}

export function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
}