
/** Seeded RNG (Mulberry32) + helpers */
export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function makeSeed(){
  // 6-digit-ish seed from crypto when available
  try{
    const u = new Uint32Array(1);
    crypto.getRandomValues(u);
    return u[0] >>> 0;
  }catch(e){
    return (Date.now() >>> 0) ^ ((Math.random()*1e9)>>>0);
  }
}
export function shuffleInPlace(arr, rnd){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(rnd()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
