const gst = require('gst-kit');

// Check Pipeline class
console.log('\n=== Pipeline class ===');
const P = gst.Pipeline || gst.default?.Pipeline;
console.log('Pipeline:', typeof P);

// Try to instantiate
let p;
try {
  p = new P('videotestsrc ! autovideosink');
  console.log('new Pipeline(string): OK');
} catch(e) {
  console.log('new Pipeline(string) failed:', e.message);
  try {
    p = new P();
    console.log('new Pipeline(): OK');
  } catch(e2) {
    console.log('new Pipeline() failed:', e2.message);
  }
}

if (p) {
  console.log('\n=== Pipeline instance methods ===');
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(p));
  console.log(proto);
  
  console.log('\n=== Pipeline own properties ===');
  console.log(Object.getOwnPropertyNames(p));
}

// Check default export
console.log('\n=== gst.default ===');
if (gst.default) console.log(Object.keys(gst.default));

// Check GstBufferFlags
console.log('\n=== GstBufferFlags (sample) ===');
const bf = gst.GstBufferFlags;
if (bf) console.log(Object.keys(bf).slice(0,5));
