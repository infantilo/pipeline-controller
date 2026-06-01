#!/bin/bash
cd "/home/infantilo/PIPELINE CONTROLLER"
node -e "
const m = require('gst-kit');
console.log('Exports:', Object.keys(m));
const p = new m.Pipeline('fakesink');
console.log('Pipeline methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(p)).join(', '));
console.log('Module path:', require.resolve('gst-kit'));
"
