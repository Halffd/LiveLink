import argparse
import logging
import re
import atexit
import subprocess
from streamlink import Streamlink, NoPluginError, PluginError, StreamError
import re

# Configure logging
log_file = 'open.log'
logging.basicConfig(
    filename=log_file,
    level=logging.INFO,
    format='%(asctime)s - %(message)s'
)

# Store the last log entry for removal
last_log_entry = None

def extract_url_parts(text):
    # Updated regex pattern to match URLs
    pattern = r'(https?:\/\/)?((([a-zA-Z0-9\-]+\.)+[a-zA-Z]{2,})|(twitch\.tv|youtu\.be))(:\d+)?(\/[^\s]*)?'
    
    # Search for all matches in the text
    matches = re.findall(pattern, text)
    
    extracted_urls = []
    for match in matches:
        protocol = match[0] if match[0] else ''  # Default to http if no protocol is provided
        domain = match[1]
        port = match[5] if match[5] else ''  # Port is optional
        path = match[6] if match[6] else ''  # Path is optional
        
        if domain:  # Ensure we have a valid domain
            full_url = f"{protocol}{domain}{port}{path}"
            extracted_urls.append(full_url)

    return extracted_urls
def log_stream_info(url, qual, n, args):
    global last_log_entry
    log_message = f"URL: {url}, Quality: {qual}, Screen Number: {n}, Fullscreen: {args.fullscreen}, Volume: {args.volume}, Cache: {args.cache}, Window Maximized: {args.window_maximized}"
    logging.info(log_message)
    last_log_entry = log_message  # Keep track of the last log entry

def remove_last_log_entry() -> None:
    global last_log_entry
    if last_log_entry is not None:
        try:
            last_log_entry = extract_url_parts(last_log_entry)[0]
        except Exception as e:
            print(e)
        with open(log_file, 'r') as file:
            lines = file.readlines()
        
        # Remove the last log entry
        with open(log_file, 'w') as file:
            for line in lines:
                if not last_log_entry in line.strip():
                    file.write(line)
        last_log_entry = None

def validate_url(url):
    return re.match(r'^(http|https|hls)://.+', url) is not None

def main():
    global last_log_entry

    parser = argparse.ArgumentParser(description="Stream video using Streamlink and play it with MPV.")
    parser.add_argument('url', type=str, help='The URL of the stream')
    parser.add_argument('qual', type=str, help='The quality of the stream (e.g., best, worst, etc.)')
    
    parser.add_argument('--screen', type=int, default=1, help='The screen number for fullscreen (default: 1)')
    parser.add_argument('--fullscreen', action='store_true', help='Enable fullscreen mode')
    parser.add_argument('--volume', type=float, default=0, help='Set initial volume')
    parser.add_argument('--cache', action='store_true', help='Enable caching')
    parser.add_argument('--window-maximized', action='store_true', help='Maximize the window')
    
    args = parser.parse_args()

    if not validate_url(args.url):
        print("Error: Invalid URL format.")
        return

    log_stream_info(args.url, args.qual, args.screen, args)

    # Register the cleanup function to remove the last log entry on exit
    atexit.register(remove_last_log_entry)

    # Initialize Streamlink
    session = Streamlink()
    
    try:
        # Get available streams
        print(args.url)
        streams = session.streams(args.url)
    except NoPluginError:
        print("Error: No plugin found for the given URL.")
        return
    except PluginError as e:
        print(f"Error: {e}")
        return
    print(streams)
    if streams == {} or not streams or streams is None or len(streams) < 1 or 'youtu' in args.url:
        stream = args
    else:
        # Get the stream for the specified quality
        if args.qual == 'best':
            args.qual = list(streams)[-1]
        if args.qual not in streams:
            print(f"Error: Quality '{args.qual}' not available. Available qualities: {streams}")
            return
        
        
        stream = streams[args.qual]

    # Open the stream and read data
    try:
        # Now send the stream to MPV
        mpv_args = [
            'mpv', 
            stream.url,
            '--fs-screen={}'.format(args.screen), 
            '--volume={}'.format(args.volume),
        ]
        if args.fullscreen:
            mpv_args.append('--fullscreen')
        if args.cache:
            mpv_args.append('--cache')
        if args.window_maximized:
            mpv_args.append('--window-maximized')

        # Start MPV as a subprocess and pipe the stream data to it
        subprocess.call(mpv_args, stdin=subprocess.PIPE)
    except StreamError as e:
        logging.error(f"Failed to start streaming: {e}")
        print(f"Error: {e}")
    except Exception as e:
        print(f"Error: {e}")
    finally:
        if last_log_entry is not None:
            remove_last_log_entry()
if __name__ == '__main__':
    main()
