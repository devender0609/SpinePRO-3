// Seeded RNG (Mulberry32) for reproducible randomization
export function mulberry32(seed){
  let t = seed >>> 0;
  return function(){
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
}
export function makeSeed(){
  // stable-ish but not guessable: time + random
  return (Date.now() ^ (Math.random()*1e9|0)) >>> 0;
}
