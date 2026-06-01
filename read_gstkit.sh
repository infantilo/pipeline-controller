#!/bin/bash
cd "/home/infantilo/PIPELINE CONTROLLER"
GSTKIT_PATH=$(node -e "console.log(require.resolve('gst-kit'))")
echo "Path: $GSTKIT_PATH"
ls "$(dirname $GSTKIT_PATH)/../"
wc -c "$GSTKIT_PATH"
cat "$GSTKIT_PATH"
