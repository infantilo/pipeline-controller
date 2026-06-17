#!/usr/bin/env python3
"""Minimal GStreamer RTSP test server — videotestsrc + sine audio."""
import sys, signal
import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstRtspServer', '1.0')
from gi.repository import GLib, Gst, GstRtspServer

port    = sys.argv[1] if len(sys.argv) > 1 else '8554'
path    = sys.argv[2] if len(sys.argv) > 2 else '/test'
pattern = sys.argv[3] if len(sys.argv) > 3 else 'smpte'
width   = sys.argv[4] if len(sys.argv) > 4 else '1920'
height  = sys.argv[5] if len(sys.argv) > 5 else '1080'
fps     = sys.argv[6] if len(sys.argv) > 6 else '25'

Gst.init(None)

launch = (
    f'( videotestsrc pattern={pattern} is-live=true'
    f' ! video/x-raw,width={width},height={height},framerate={fps}/1'
    f' ! videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast key-int-max=25'
    f' ! rtph264pay name=pay0 pt=96'
    f' audiotestsrc wave=sine freq=1000 is-live=true'
    f' ! audio/x-raw,rate=48000,channels=2'
    f' ! audioconvert ! opusenc ! rtpopuspay name=pay1 pt=97 )'
)

server  = GstRtspServer.RTSPServer.new()
server.set_service(port)
mounts  = server.get_mount_points()
factory = GstRtspServer.RTSPMediaFactory.new()
factory.set_launch(launch)
factory.set_shared(True)
mounts.add_factory(path, factory)
server.attach(None)

url = f'rtsp://127.0.0.1:{port}{path}'
print(f'RTSP_URL:{url}', flush=True)

loop = GLib.MainLoop()
signal.signal(signal.SIGTERM, lambda *_: loop.quit())
signal.signal(signal.SIGINT,  lambda *_: loop.quit())
loop.run()
