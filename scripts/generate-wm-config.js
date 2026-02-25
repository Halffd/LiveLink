#!/usr/bin/env node

/**
 * LiveLink Window Manager Config Generator
 * 
 * Generates window manager configuration files from player.json
 * Supports: i3, sway, hyprland, bspwm, xmonad, awesome, qtile, openbox
 * 
 * Usage: node scripts/generate-wm-config.js [wm-type] [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Window Manager templates
const WM_TEMPLATES = {
	i3: {
		name: 'i3/i3-gaps',
		configPath: '~/.config/i3/config',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration
# Add this to your ~/.config/i3/config

# Float LiveLink windows
for_window [class="livelink-screen-*"] floating enable

# Set specific geometry for each screen
${screens.map(s => `for_window [class="livelink-screen-${s.screen}"] resize set ${s.width} ${s.height}, move position ${s.x} ${s.y}`).join('\n')}
`.trim(),
		apply: 'Reload i3: $mod+Shift+r'
	},

	sway: {
		name: 'Sway',
		configPath: '~/.config/sway/config',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration
# Add this to your ~/.config/sway/config

# Float LiveLink windows
for_window [app_id="livelink-screen-*"] floating enable

# Set specific geometry for each screen
${screens.map(s => `for_window [app_id="livelink-screen-${s.screen}"] resize set ${s.width} ${s.height}, move position ${s.x} ${s.y}`).join('\n')}
`.trim(),
		apply: 'Reload Sway: swaymsg reload'
	},

	hyprland: {
		name: 'Hyprland (v0.45+)',
		configPath: '~/.config/hypr/hyprland.conf',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration
# Float and position LiveLink windows

${screens.map(s => `# Screen ${s.screen}
windowrule {
  name = livelink-screen-${s.screen}
  match:class = livelink-screen-${s.screen}
  float = on
  size = ${s.width} ${s.height}
  move = ${s.x} ${s.y}
}`).join('\n\n')}

# Or use anonymous rule syntax for all screens:
# windowrule = float on, match:class livelink-screen-.*
# windowrule = size ${screens[0]?.width || 1280} ${screens[0]?.height || 720}, match:class livelink-screen-.*
# windowrule = move 0 0, match:class livelink-screen-1
`.trim(),
		apply: 'Hyprland auto-reloads on config change',
		generateLegacy: (screens) => `
# For Hyprland versions < 0.45, use windowrulev2 instead:
${screens.map(s => `windowrulev2 = float, class:livelink-screen-${s.screen}
windowrulev2 = size ${s.width} ${s.height}, class:livelink-screen-${s.screen}
windowrulev2 = move ${s.x} ${s.y}, class:livelink-screen-${s.screen}`).join('\n')}
`.trim()
	},

	bspwm: {
		name: 'BSPWM',
		configPath: '~/.config/bspwm/bspwmrc',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration
# Add this to your ~/.config/bspwm/bspwmrc

# Float LiveLink windows
bspc rule -a livelink-screen-* state=floating

# Set specific geometry for each screen
${screens.map(s => `bspc rule -a livelink-screen-${s.screen} state=floating rectangle=${s.width}x${s.height}+${s.x}+${s.y}`).join('\n')}
`.trim(),
		apply: 'Reload BSPWM: bspwm -c ~/.config/bspwm/bspwmrc'
	},

	xmonad: {
		name: 'Xmonad',
		configPath: '~/.xmonad/xmonad.hs',
		generate: (screens) => `
-- LiveLink Auto-Generated Configuration
-- Add to your manageHook in ~/.xmonad/xmonad.hs

import XMonad.Actions.FloatKeys (actionFloat)
import XMonad.StackSet (RationalRect(..))

myManageHook = composeAll
    [ className =? c --> doFloat (RationalRect l t w h) | (c, l, t, w, h) <- [
${screens.map(s => `        ("livelink-screen-${s.screen}", ${s.x / 1920}, ${s.y / 1080}, ${s.width / 1920}, ${s.height / 1080})`).join(',\n')}
    ]]

-- Or with absolute positioning:
myManageHook' = composeAll
    [ className =? "livelink-screen-*" --> doFloat (RationalRect 0 0 0 0)
    ]

-- Then use keybindings to position windows:
-- , ((modMask .|. shiftMask, xK_Return), \w -> do
--     when (isLivelink w) $ do
--         liftIO $ runProcess "xdotool" ["search", "--name", "LiveLink", "windowmove", "0", "0", "1280", "720"]
--     )
`.trim(),
		apply: 'Recompile and restart: xmonad --recompile && xmonad --restart'
	},

	awesome: {
		name: 'AwesomeWM',
		configPath: '~/.config/awesome/rc.lua',
		generate: (screens) => `
-- LiveLink Auto-Generated Configuration
-- Add to your awful.rules.rules in ~/.config/awesome/rc.lua

awful.rules.rules = {
    {
        rule = { class = "livelink-screen-.*" },
        properties = { floating = true, ontop = true },
        callback = function(c)
            awful.placement.top_left(c, { margins = { top = 0, left = 0 } })
            c:connect_signal("manage", function()
${screens.map(s => `                if c.class == "livelink-screen-${s.screen}" then
                    c:geometry({ x = ${s.x}, y = ${s.y}, width = ${s.width}, height = ${s.height} })
                end`).join('\n')}
            end)
        end
    }
}
`.trim(),
		apply: 'Reload Awesome: $mod+Control+r'
	},

	qtile: {
		name: 'Qtile',
		configPath: '~/.config/qtile/config.py',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration
# Add to your ~/.config/qtile/config.py

from libqtile import hook
from libqtile.backend.x11 import window

@hook.subscribe.client_new
def float_livelink(client):
    wm_class = client.get_wm_class()
    if wm_class and "livelink-screen-" in wm_class[0]:
        client.floating = True
        client.enable_fullscreen = False
${screens.map(s => `        if "livelink-screen-${s.screen}" in wm_class[0]:
            client.cmd_set_position(${s.x}, ${s.y})
            client.cmd_set_size(${s.width}, ${s.height})`).join('\n')}
`.trim(),
		apply: 'Reload Qtile: $mod+Control+r'
	},

	openbox: {
		name: 'Openbox',
		configPath: '~/.config/openbox/rc.xml',
		generate: (screens) => `
<!-- LiveLink Auto-Generated Configuration -->
<!-- Add to your ~/.config/openbox/rc.xml inside <applications> -->

<applications>
${screens.map(s => `  <application class="livelink-screen-${s.screen}">
    <position force="yes">
      <x>${s.x}</x>
      <y>${s.y}</y>
    </position>
    <size>
      <width>${s.width}</width>
      <height>${s.height}</height>
    </size>
    <layer>normal</layer>
    <decor>yes</decor>
  </application>`).join('\n')}
</applications>
`.trim(),
		apply: 'Reload Openbox: openbox --reconfigure'
	},

	kwin: {
		name: 'KWin (KDE)',
		configPath: 'System Settings → Window Management → Window Rules',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration for KWin
# 
# Option 1: Use KWin Scripts
# Create: ~/.local/share/kwin/scripts/livelink-float/code/main.js

function init() {
    workspace.clientAdded.connect(function(client) {
        if (client.resourceClass && client.resourceClass.includes("livelink-screen-")) {
            client.keepAbove = true;
${screens.map(s => `            if (client.resourceClass.includes("livelink-screen-${s.screen}")) {
                // Note: KWin scripts can't set geometry directly
                // Use window rules instead
            }`).join('\n')}
        }
    });
}

# Option 2: Use Window Rules (Recommended)
# Go to: System Settings → Window Management → Window Rules
# Add new rule for each screen:
${screens.map(s => `# Screen ${s.screen}:
# - Window class (exact match): livelink-screen-${s.screen}
# - Size & Position: Force
# - Position: ${s.x},${s.y}
# - Size: ${s.width}x${s.height}
`).join('\n')}
`.trim(),
		apply: 'Window rules apply immediately, script requires KWin restart'
	},

	wayfire: {
		name: 'Wayfire',
		configPath: '~/.config/wayfire.ini',
		generate: (screens) => `
# LiveLink Auto-Generated Configuration
# Add to your ~/.config/wayfire.ini

[window-rules]
${screens.map((s, i) => `rule${i + 1} = create float class livelink-screen-${s.screen}
rule${i + screens.length + 1} = move ${s.x} ${s.y} class livelink-screen-${s.screen}
rule${i + (screens.length * 2) + 1} = set_geometry ${s.width} ${s.height} class livelink-screen-${s.screen}`).join('\n')}
`.trim(),
		apply: 'Reload Wayfire: wayfire --reload'
	}
};

function loadPlayerConfig() {
	const configPaths = [
		join(process.cwd(), 'config', 'player.json'),
		join(process.cwd(), 'player.json'),
		join(__dirname, '..', 'config', 'player.json')
	];

	for (const configPath of configPaths) {
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, 'utf-8');
				const config = JSON.parse(content);
				return config;
			} catch (error) {
				console.error(`Error reading ${configPath}:`, error.message);
			}
		}
	}

	throw new Error('player.json not found. Run LiveLink first to generate config.');
}

function extractScreens(playerConfig) {
	if (!playerConfig.screens || !Array.isArray(playerConfig.screens)) {
		throw new Error('No screens found in player.json');
	}

	return playerConfig.screens
		.filter(screen => screen.enabled !== false)
		.map(screen => ({
			screen: screen.screen || screen.id,
			width: screen.width || 1280,
			height: screen.height || 720,
			x: screen.x || 0,
			y: screen.y || 0
		}));
}

function generateConfig(wmType, screens, dryRun = false) {
	const template = WM_TEMPLATES[wmType];
	if (!template) {
		throw new Error(`Unknown WM type: ${wmType}\nSupported: ${Object.keys(WM_TEMPLATES).join(', ')}`);
	}

	const config = template.generate(screens);

	if (dryRun) {
		console.log(`\n=== ${template.name} Configuration ===`);
		console.log(`Target: ${template.configPath}`);
		console.log('\n--- Generated Config ---\n');
		console.log(config);
		if (template.generateLegacy) {
			console.log('\n--- Legacy Version (for older WM versions) ---\n');
			console.log(template.generateLegacy(screens));
		}
		console.log('\n--- End Config ---\n');
		console.log(`Apply: ${template.apply}\n`);
		return null;
	}

	return { config, template };
}

function saveConfig(config, template, wmType) {
	const outputDir = join(process.cwd(), 'generated-wm-configs');
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir, { recursive: true });
	}

	const extensions = {
		i3: 'i3',
		sway: 'sway',
		hyprland: 'conf',
		bspwm: 'sh',
		xmonad: 'hs',
		awesome: 'lua',
		qtile: 'py',
		openbox: 'xml',
		kwin: 'js',
		wayfire: 'ini'
	};

	const filename = `livelink-${wmType}.${extensions[wmType] || 'txt'}`;
	const filepath = join(outputDir, filename);

	writeFileSync(filepath, config, 'utf-8');
	console.log(`✓ Configuration saved to: ${filepath}`);
	console.log(`  Target location: ${template.configPath}`);
	console.log(`  Apply: ${template.apply}\n`);

	return filepath;
}

function showHelp() {
	console.log(`
LiveLink Window Manager Config Generator

Usage: node scripts/generate-wm-config.js [options] [wm-type]

Options:
  --dry-run, -d    Show config without saving
  --all            Generate configs for all supported WMs
  --help, -h       Show this help message

Supported WM types:
  ${Object.keys(WM_TEMPLATES).join(', ')}

Examples:
  node scripts/generate-wm-config.js hyprland
  node scripts/generate-wm-config.js i3 --dry-run
  node scripts/generate-wm-config.js --all

The script reads from config/player.json and generates
window manager rules to float and position LiveLink windows.
`.trim());
}

// Main execution
function main() {
	const args = process.argv.slice(2);

	if (args.includes('--help') || args.includes('-h')) {
		showHelp();
		process.exit(0);
	}

	const dryRun = args.includes('--dry-run') || args.includes('-d');
	const generateAll = args.includes('--all');

	try {
		const playerConfig = loadPlayerConfig();
		const screens = extractScreens(playerConfig);

		console.log(`Found ${screens.length} enabled screen(s):\n`);
		screens.forEach(s => {
			console.log(`  Screen ${s.screen}: ${s.width}x${s.height} at ${s.x},${s.y}`);
		});
		console.log('');

		if (generateAll) {
			console.log('Generating configs for all supported window managers...\n');
			Object.keys(WM_TEMPLATES).forEach(wmType => {
				try {
					const result = generateConfig(wmType, screens, dryRun);
					if (result && !dryRun) {
						saveConfig(result.config, result.template, wmType);
					}
				} catch (error) {
					console.error(`✗ Failed to generate ${wmType} config:`, error.message);
				}
			});
		} else {
			const wmType = args.find(arg => !arg.startsWith('-'));
			if (!wmType) {
				console.error('Error: Please specify a window manager type\n');
				showHelp();
				process.exit(1);
			}

			const result = generateConfig(wmType, screens, dryRun);
			if (result && !dryRun) {
				saveConfig(result.config, result.template, wmType);
			}
		}

		if (!dryRun && !generateAll) {
			console.log('Tip: Use --all to generate configs for all WMs');
			console.log('     Use --dry-run to preview before saving\n');
		}

	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
}

main();
