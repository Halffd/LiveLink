# Generated Window Manager Configurations

This directory contains auto-generated window manager configurations for LiveLink.
These files are generated from your `config/player.json` settings.

## Generated Files

Each file corresponds to a different window manager:

- `livelink-i3.i3` - i3 / i3-gaps
- `livelink-sway.sway` - Sway
- `livelink-hyprland.conf` - Hyprland (v0.45+ with modern `windowrule { }` syntax)
- `livelink-bspwm.sh` - BSPWM
- `livelink-xmonad.hs` - Xmonad
- `livelink-awesome.lua` - AwesomeWM
- `livelink-qtile.py` - Qtile
- `livelink-openbox.xml` - Openbox
- `livelink-kwin.js` - KWin (KDE)
- `livelink-wayfire.ini` - Wayfire

## How to Use

### Option 1: Copy to WM Config Location

Copy the appropriate file to your WM's configuration directory:

```bash
# i3
cp generated-wm-configs/livelink-i3.i3 ~/.config/i3/config.d/livelink.conf
# Then include it in your main config:
# include ~/.config/i3/config.d/livelink.conf

# Sway
cp generated-wm-configs/livelink-sway.sway ~/.config/sway/config.d/livelink.conf
# Then include it in your main config:
# include ~/.config/sway/config.d/livelink.conf

# Hyprland (append to existing config)
cat generated-wm-configs/livelink-hyprland.conf >> ~/.config/hypr/hyprland.conf

# BSPWM
cat generated-wm-configs/livelink-bspwm.sh >> ~/.config/bspwm/bspwmrc
```

### Option 2: Manual Copy-Paste

Open the generated file and copy-paste the contents into your WM's config file.

### Option 3: Regenerate Anytime

After changing your screen configuration in `config/player.json`, regenerate:

```bash
# Generate for specific WM
npm run wm:config hyprland

# Generate for all WMs
npm run wm:config:all

# Preview without saving
npm run wm:config hyprland -- --dry-run
```

## Window Class

All LiveLink windows use the class name `livelink-screen-{N}` where `{N}` is the screen number.
This allows your window manager to identify and apply rules to each window.

## Hyprland-Specific Notes

### Modern Syntax (v0.45+)

The generated config uses the modern `windowrule { }` block syntax:

```bash
windowrule {
  name = livelink-screen-1
  match:class = livelink-screen-1
  float = on
  size = 1920 1080
  move = 1366 0
}
```

### Legacy Syntax (< v0.45)

For older Hyprland versions, use the legacy syntax:

```bash
windowrulev2 = float, class:livelink-screen-1
windowrulev2 = size 1920 1080, class:livelink-screen-1
windowrulev2 = move 1366 0, class:livelink-screen-1
```

### Tips

- Use `hyprctl clients` to see window information
- Rules are evaluated top to bottom
- Named rules take precedence over anonymous rules
- Hyprland auto-reloads when config changes

## Regeneration

These files are auto-generated. If you modify `config/player.json`, regenerate the configs:

```bash
npm run wm:config:all
```

## Manual Edits

⚠️ **Warning**: Manual edits to these files will be overwritten when regenerating.

If you need custom rules:
1. Copy the generated file to another location
2. Edit the copy
3. Reference the copy from your WM config
4. Or add custom rules directly to your WM config

## Troubleshooting

### Windows not floating
- Verify the window class matches: `hyprctl clients` (Wayland) or `xprop | grep WM_CLASS` (X11)
- Check WM config syntax
- Reload WM configuration

### Wrong position/size
- Check `config/player.json` for correct screen dimensions
- Regenerate configs after changes
- Some WMs may have different coordinate systems

### Config not applying
- Ensure the config file is in the correct location
- Reload/restart your window manager
- Check WM logs for errors

## Customization

For advanced customization, edit the generator script:
`scripts/generate-wm-config.js`

You can:
- Add new WM templates
- Modify existing templates
- Add custom logic for specific screens
