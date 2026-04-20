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

export function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI__' in window;
}