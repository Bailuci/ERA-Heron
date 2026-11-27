/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：新增确定性数学库 det_math，供表达式 $expr 与钩子使用，保证不同浏览器引擎上逐位一致
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * @file ERA 变量框架 - 确定性数学库
 * @description
 * ECMAScript 规范允许 `Math.sin/exp/log/pow` 等函数由各引擎自行近似实现：V8 与 SpiderMonkey 大多移植自 fdlibm，
 * 而 JavaScriptCore（iOS 上的所有浏览器）调用系统 libm，末位可能不同。表达式和钩子会在重算时再次执行，
 * 结果必须只取决于输入，因此这里用纯 JS 移植 fdlibm，只使用四则运算、比较、位运算，
 * 以及规范要求精确的 `Math.sqrt/abs/floor/ceil/trunc`。各引擎的结果逐位一致，
 * 并与 Java `StrictMath`（规范要求与 fdlibm 一致）相同，测试中用它生成的位模式作为金标准。
 *
 * `log2` 移植自 FreeBSD msun 的 `e_log2.c`（fdlibm 没有该函数），`asinh/acosh/atanh` 移植自 fdlibm 5.3。
 *
 * 本文件中的算法与常数来自 fdlibm 5.3 与 FreeBSD msun，按其许可保留以下声明：
 *
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 *
 * ====================================================
 * Copyright (C) 2004 by Sun Microsystems, Inc. All rights reserved.
 *
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */
'use strict';

// ---------------------------------------------------------------------------
// 读写 IEEE 754 双精度的高、低 32 位。DataView 默认大端，偏移 0 是高位，与平台字节序无关。
// ---------------------------------------------------------------------------

const view = new DataView(new ArrayBuffer(8));

/** 高 32 位（有符号）。 */
function highWord(x: number): number {
  view.setFloat64(0, x);
  return view.getInt32(0);
}

/** 低 32 位（无符号）。 */
function lowWord(x: number): number {
  view.setFloat64(0, x);
  return view.getUint32(4);
}

function fromWords(high: number, low: number): number {
  view.setInt32(0, high | 0);
  view.setUint32(4, low >>> 0);
  return view.getFloat64(0);
}

function withHighWord(x: number, high: number): number {
  view.setFloat64(0, x);
  view.setInt32(0, high | 0);
  return view.getFloat64(0);
}

function withLowWord(x: number, low: number): number {
  view.setFloat64(0, x);
  view.setUint32(4, low >>> 0);
  return view.getFloat64(0);
}

const HUGE = 1.0e300;
const TINY = 1.0e-300;
const TWO54 = 1.8014398509481984e16; // 0x43500000 00000000
const TWOM54 = 5.551115123125783e-17; // 0x3C900000 00000000

/** x * 2^n，结果只舍入一次（fdlibm `scalbn`）。 */
function scalbn(x: number, n: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = (hx & 0x7ff00000) >> 20;
  if (k === 0) {
    if ((lx | (hx & 0x7fffffff)) === 0) return x;
    x *= TWO54;
    hx = highWord(x);
    k = ((hx & 0x7ff00000) >> 20) - 54;
    if (n < -50000) return TINY * x;
  }
  if (k === 0x7ff) return x + x;
  k += n;
  if (k > 0x7fe) return HUGE * (x < 0 ? -HUGE : HUGE);
  if (k > 0) return withHighWord(x, (hx & 0x800fffff) | (k << 20));
  if (k <= -54) {
    if (n > 50000) return HUGE * (x < 0 ? -HUGE : HUGE);
    return TINY * (x < 0 ? -TINY : TINY);
  }
  k += 54;
  return withHighWord(x, (hx & 0x800fffff) | (k << 20)) * TWOM54;
}

/** 2^k，k 在 [-1022, 1023] 内。 */
const pow2 = (k: number): number => fromWords((0x3ff + k) << 20, 0);

// ---------------------------------------------------------------------------
// exp / expm1
// ---------------------------------------------------------------------------

const LN2_HI = 6.9314718036912381649e-1; // 0x3FE62E42 FEE00000
const LN2_LO = 1.90821492927058770002e-10; // 0x3DEA39EF 35793C76
const INV_LN2 = 1.442695040888963387; // 0x3FF71547 652B82FE
const O_THRESHOLD = 7.09782712893383973096e2; // 0x40862E42 FEFA39EF
const U_THRESHOLD = -7.4513321910194110842e2; // 0xC0874910 D52D3051
const TWOM1000 = 9.3326361850321887899e-302; // 2^-1000
const P1 = 1.66666666666666019037e-1; // 0x3FC55555 5555553E
const P2 = -2.77777777770155933842e-3; // 0xBF66C16C 16BEBD93
const P3 = 6.61375632143793436117e-5; // 0x3F11566A AF25DE2C
const P4 = -1.6533902205465251539e-6; // 0xBEBBBD41 C5D26BF1
const P5 = 4.13813679705723846039e-8; // 0x3E663769 72BEA4D0

/** e^x（fdlibm `e_exp.c`）。 */
export function exp(x: number): number {
  let hx = highWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;

  if (hx >= 0x40862e42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0;
    }
    if (x > O_THRESHOLD) return HUGE * HUGE;
    if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
  }

  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      hi = x - (xsb === 0 ? LN2_HI : -LN2_HI);
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    return 1 + x;
  }

  const t = x * x;
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  const y = 1 - (lo - (x * c) / (2.0 - c) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2.0 * pow2(1023);
    return y * pow2(k);
  }
  return y * pow2(k + 1000) * TWOM1000;
}

const Q1 = -3.33333333333331316428e-2; // 0xBFA11111 111110F4
const Q2 = 1.58730158725481460165e-3; // 0x3F5A01A0 19FE5585
const Q3 = -7.93650757867487942473e-5; // 0xBF14CE19 9EAADBB7
const Q4 = 4.00821782732936239552e-6; // 0x3ED0CFCA 86E65239
const Q5 = -2.01099218183624371326e-7; // 0xBE8AFDB7 6E09C32D

/** e^x - 1，x 接近 0 时仍然精确（fdlibm `s_expm1.c`）。 */
export function expm1(x: number): number {
  let hx = highWord(x);
  const xsb = hx & 0x80000000;
  hx &= 0x7fffffff;

  if (hx >= 0x4043687a) {
    if (hx >= 0x40862e42) {
      if (hx >= 0x7ff00000) {
        if (((hx & 0xfffff) | lowWord(x)) !== 0) return x + x;
        return xsb === 0 ? x : -1.0;
      }
      if (x > O_THRESHOLD) return HUGE * HUGE;
    }
    if (xsb !== 0) return TINY - 1;
  }

  let hi = 0;
  let lo = 0;
  let c = 0;
  let k = 0;
  if (hx > 0x3fd62e42) {
    if (hx < 0x3ff0a2b2) {
      if (xsb === 0) {
        hi = x - LN2_HI;
        lo = LN2_LO;
        k = 1;
      } else {
        hi = x + LN2_HI;
        lo = -LN2_LO;
        k = -1;
      }
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI;
      lo = k * LN2_LO;
    }
    x = hi - lo;
    c = hi - x - lo;
  } else if (hx < 0x3c900000) {
    return x;
  }

  const hfx = 0.5 * x;
  const hxs = x * hfx;
  const r1 = 1 + hxs * (Q1 + hxs * (Q2 + hxs * (Q3 + hxs * (Q4 + hxs * Q5))));
  let t = 3.0 - r1 * hfx;
  let e = hxs * ((r1 - t) / (6.0 - x * t));
  if (k === 0) return x - (x * e - hxs);
  e = x * (e - c) - c;
  e -= hxs;
  if (k === -1) return 0.5 * (x - e) - 0.5;
  if (k === 1) {
    if (x < -0.25) return -2.0 * (e - (x + 0.5));
    return 1 + 2.0 * (x - e);
  }
  let y: number;
  if (k <= -2 || k > 56) {
    y = 1 - (e - x);
    y = k === 1024 ? y * 2.0 * pow2(1023) : y * pow2(k);
    return y - 1;
  }
  if (k < 20) {
    t = fromWords(0x3ff00000 - (0x200000 >> k), 0); // 1 - 2^-k
    y = t - (e - x);
  } else {
    t = fromWords((0x3ff - k) << 20, 0); // 2^-k
    y = x - (e + t);
    y += 1;
  }
  return y * pow2(k);
}

// ---------------------------------------------------------------------------
// log / log1p / log2 / log10
// ---------------------------------------------------------------------------

const LG1 = 6.66666666666673513e-1; // 0x3FE55555 55555593
const LG2 = 3.999999999940941908e-1; // 0x3FD99999 9997FA04
const LG3 = 2.857142874366239149e-1; // 0x3FD24924 94229359
const LG4 = 2.222219843214978396e-1; // 0x3FCC71C5 1D8E78AF
const LG5 = 1.818357216161805012e-1; // 0x3FC74664 96CB03DE
const LG6 = 1.531383769920937332e-1; // 0x3FC39A09 D078C69F
const LG7 = 1.479819860511658591e-1; // 0x3FC2F112 DF3E5244

/** 自然对数（fdlibm `e_log.c`）。 */
export function log(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHighWord(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) {
      if (k === 0) return 0;
      return k * LN2_HI + k * LN2_LO;
    }
    const R = f * f * (0.5 - 0.3333333333333333 * f);
    if (k === 0) return f - R;
    return k * LN2_HI - (R - k * LN2_LO - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - (hfsq - (s * (hfsq + R) + dk * LN2_LO) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - (s * (f - R) - dk * LN2_LO - f);
}

/** ln(1 + x)，x 接近 0 时仍然精确（fdlibm `s_log1p.c`）。 */
export function log1p(x: number): number {
  const hx = highWord(x);
  const ax = hx & 0x7fffffff;

  let k = 1;
  let f = 0;
  let c = 0;
  let hu = 0;
  if (hx < 0x3fda827a) {
    if (ax >= 0x3ff00000) {
      if (x === -1.0) return -Infinity;
      return NaN;
    }
    if (ax < 0x3e200000) {
      if (ax < 0x3c900000) return x;
      return x - x * x * 0.5;
    }
    if (hx > 0 || hx <= (0xbfd2bec3 | 0)) {
      k = 0;
      f = x;
      hu = 1;
    }
  }
  if (hx >= 0x7ff00000) return x + x;
  if (k !== 0) {
    let u: number;
    if (hx < 0x43400000) {
      u = 1.0 + x;
      hu = highWord(u);
      k = (hu >> 20) - 1023;
      c = k > 0 ? 1.0 - (u - x) : x - (u - 1.0);
      c /= u;
    } else {
      u = x;
      hu = highWord(u);
      k = (hu >> 20) - 1023;
      c = 0;
    }
    hu &= 0x000fffff;
    if (hu < 0x6a09e) {
      u = withHighWord(u, hu | 0x3ff00000);
    } else {
      k += 1;
      u = withHighWord(u, hu | 0x3fe00000);
      hu = (0x00100000 - hu) >> 2;
    }
    f = u - 1.0;
  }
  const hfsq = 0.5 * f * f;
  if (hu === 0) {
    if (f === 0) {
      if (k === 0) return 0;
      c += k * LN2_LO;
      return k * LN2_HI + c;
    }
    const R = hfsq * (1.0 - 0.6666666666666666 * f);
    if (k === 0) return f - R;
    return k * LN2_HI - (R - (k * LN2_LO + c) - f);
  }
  const s = f / (2.0 + f);
  const z = s * s;
  const R = z * (LG1 + z * (LG2 + z * (LG3 + z * (LG4 + z * (LG5 + z * (LG6 + z * LG7))))));
  if (k === 0) return f - (hfsq - s * (hfsq + R));
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + (k * LN2_LO + c)) - f);
}

const IVLN10 = 4.34294481903251816668e-1; // 0x3FDBCB7B 1526E50E
const LOG10_2HI = 3.01029995663611771306e-1; // 0x3FD34413 509F6000
const LOG10_2LO = 3.69423907715893078616e-13; // 0x3D59FEF3 11F12B36

/** 常用对数（fdlibm `e_log10.c`）。10 的整数次幂得到精确的整数。 */
export function log10(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  const i = (k & 0x80000000) >>> 31;
  hx = (hx & 0x000fffff) | ((0x3ff - i) << 20);
  const y = k + i;
  x = withHighWord(x, hx);
  const z = y * LOG10_2LO + IVLN10 * log(x);
  return z + y * LOG10_2HI;
}

const IVLN2HI = 1.44269504072144627571; // 0x3FF71547 65200000
const IVLN2LO = 1.67517131648865118353e-10; // 0x3DE705FC 2EEFA200

/** 以 2 为底的对数（FreeBSD msun `e_log2.c`）。2 的整数次幂得到精确的整数。 */
export function log2(x: number): number {
  let hx = highWord(x);
  const lx = lowWord(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = highWord(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  if (hx === 0x3ff00000 && lx === 0) return 0;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  x = withHighWord(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const y = k;
  const f = x - 1.0;
  const hfsq = 0.5 * f * f;
  // k_log1p(f)
  const s = f / (2.0 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const r = s * (hfsq + (t2 + t1));

  const hi = withLowWord(f - hfsq, 0);
  const lo = f - hi - hfsq + r;
  let valHi = hi * IVLN2HI;
  let valLo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
  const sum = y + valHi;
  valLo += y - sum + valHi;
  valHi = sum;
  return valLo + valHi;
}

// ---------------------------------------------------------------------------
// 三角函数的辅助：内核与参数约化
// ---------------------------------------------------------------------------

const S1 = -1.66666666666666324348e-1; // 0xBFC55555 55555549
const S2 = 8.33333333332248946124e-3; // 0x3F811111 1110F8A6
const S3 = -1.98412698298579493134e-4; // 0xBF2A01A0 19C161D5
const S4 = 2.75573137070700676789e-6; // 0x3EC71DE3 57B1FE7D
const S5 = -2.50507602534068634195e-8; // 0xBE5AE5E6 8A2B9CEB
const S6 = 1.58969099521155010221e-10; // 0x3DE5D93A 5ACFD57C

/** sin 的内核，|x| <= π/4，y 是 x 的尾数部分（fdlibm `k_sin.c`）。 */
function kernelSin(x: number, y: number, iy: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 4.16666666666666019037e-2; // 0x3FA55555 5555554C
const C2 = -1.38888888888741095749e-3; // 0xBF56C16C 16C15177
const C3 = 2.48015872894767294178e-5; // 0x3EFA01A0 19CB1590
const C4 = -2.75573143513906633035e-7; // 0xBE927E4F 809C52AD
const C5 = 2.0875723212981748279e-9; // 0x3E21EE9E BDB4B1C4
const C6 = -1.13596475577881948265e-11; // 0xBDA8FAE9 BE8838D4

/** cos 的内核（fdlibm `k_cos.c`）。 */
function kernelCos(x: number, y: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix < 0x3e400000 && Math.trunc(x) === 0) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ix < 0x3fd33333) return 1 - (0.5 * z - (z * r - x * y));
  const qx = ix > 0x3fe90000 ? 0.28125 : fromWords(ix - 0x00200000, 0);
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

const T = [
  3.33333333333334091986e-1, // 3FD55555 55555563
  1.33333333333201242699e-1, // 3FC11111 1110FE7A
  5.39682539762260521377e-2, // 3FABA1BA 1BB341FE
  2.18694882948595424599e-2, // 3F9664F4 8406D637
  8.86323982359930005737e-3, // 3F8226E3 E96E8493
  3.59207910759131235356e-3, // 3F6D6D22 C9560328
  1.45620945432529025516e-3, // 3F57DBC8 FEE08315
  5.88041240820264096874e-4, // 3F4344D8 F2F26501
  2.46463134818469906812e-4, // 3F3026F7 1A8D1068
  7.817944429395570923e-5, // 3F147E88 A03792A6
  7.14072491382608190305e-5, // 3F12B80F 32F0A7E9
  -1.85586374855275456654e-5, // BEF375CB DB605373
  2.59073051863633712884e-5, // 3EFB2A70 74BF7AD4
];
const PIO4 = 7.85398163397448278999e-1; // 3FE921FB 54442D18
const PIO4LO = 3.06161699786838301793e-17; // 3C81A626 33145C07

/** tan 的内核；iy 为 1 时返回 tan，为 -1 时返回 -1/tan（fdlibm `k_tan.c`，2004 年修订版）。 */
function kernelTan(x: number, y: number, iy: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix < 0x3e300000 && Math.trunc(x) === 0) {
    if ((ix | lowWord(x) | (iy + 1)) === 0) return 1 / Math.abs(x);
    if (iy === 1) return x;
    // 精确计算 -1 / (x + y)
    const w = x + y;
    const z = withLowWord(w, 0);
    const v = y - (z - x);
    const a = -1 / w;
    const t = withLowWord(a, 0);
    const s = 1 + t * z;
    return t + a * (s + t * v);
  }
  if (ix >= 0x3fe59428) {
    if (hx < 0) {
      x = -x;
      y = -y;
    }
    const z = PIO4 - x;
    const w = PIO4LO - y;
    x = z + w;
    y = 0.0;
  }
  const z = x * x;
  let w = z * z;
  let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
  let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
  let s = z * x;
  r = y + z * (s * (r + v) + y);
  r += T[0] * s;
  w = x + r;
  if (ix >= 0x3fe59428) {
    v = iy;
    return (1 - ((hx >> 30) & 2)) * (v - 2.0 * (x - ((w * w) / (w + v) - r)));
  }
  if (iy === 1) return w;
  // 精确计算 -1 / (x + r)
  const zz = withLowWord(w, 0);
  v = r - (zz - x);
  const a = -1.0 / w;
  const t = withLowWord(a, 0);
  s = 1.0 + t * zz;
  return t + a * (s + t * v);
}

/** 2/π 的前 1584 位，每项 24 位。 */
// prettier-ignore
const TWO_OVER_PI = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62, 0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7,
  0x246e3a, 0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129, 0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c,
  0x7026b4, 0x5f7e41, 0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8, 0x97ffde, 0x05980f, 0xef2f11,
  0x8b5a0a, 0x6d1f6d, 0x367ecf, 0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5, 0xf17b3d, 0x0739f7,
  0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08, 0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3, 0x91615e,
  0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880, 0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
];

/** π/2 分段，每段 24 位。 */
const PIO2 = [
  1.57079625129699707031, // 0x3FF921FB 40000000
  7.54978941586159635335e-8, // 0x3E74442D 00000000
  5.39030252995776476554e-15, // 0x3CF84698 80000000
  3.28200341580791294123e-22, // 0x3B78CC51 60000000
  1.27065575308067607349e-29, // 0x39F01B83 80000000
  1.22933308981111328932e-36, // 0x387A2520 40000000
  2.73370053816464559624e-44, // 0x36E38222 80000000
  2.16741683877804819444e-51, // 0x3569F31D 00000000
];

const TWO24 = 1.6777216e7; // 0x41700000 00000000
const TWON24 = 5.9604644775390625e-8; // 0x3E700000 00000000

/** 大参数的约化，精度 prec = 2（fdlibm `k_rem_pio2.c`）。结果写入 y，返回 n & 7。 */
function kernelRemPio2(x: number[], y: number[], e0: number, nx: number): number {
  const jk = 4; // init_jk[2]
  const jp = jk;
  const iq: number[] = new Array(20).fill(0);
  const f: number[] = new Array(20).fill(0);
  const fq: number[] = new Array(20).fill(0);
  const q: number[] = new Array(20).fill(0);

  const jx = nx - 1;
  let jv = Math.trunc((e0 - 3) / 24);
  if (jv < 0) jv = 0;
  let q0 = e0 - 24 * (jv + 1);

  let j = jv - jx;
  const m = jx + jk;
  for (let i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0 : TWO_OVER_PI[j];

  for (let i = 0; i <= jk; i++) {
    let fw = 0.0;
    for (j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
    q[i] = fw;
  }

  let jz = jk;
  let z: number;
  let n: number;
  let ih: number;
  for (;;) {
    // 把 q[] 逆序拆成 24 位整数 iq[]
    let i = 0;
    z = q[jz];
    for (j = jz; j > 0; i++, j--) {
      const fw = Math.trunc(TWON24 * z);
      iq[i] = Math.trunc(z - TWO24 * fw);
      z = q[j - 1] + fw;
    }

    z = scalbn(z, q0);
    z -= 8.0 * Math.floor(z * 0.125);
    n = Math.trunc(z);
    z -= n;
    ih = 0;
    if (q0 > 0) {
      i = iq[jz - 1] >> (24 - q0);
      n += i;
      iq[jz - 1] -= i << (24 - q0);
      ih = iq[jz - 1] >> (23 - q0);
    } else if (q0 === 0) {
      ih = iq[jz - 1] >> 23;
    } else if (z >= 0.5) {
      ih = 2;
    }

    if (ih > 0) {
      n += 1;
      let carry = 0;
      for (i = 0; i < jz; i++) {
        j = iq[i];
        if (carry === 0) {
          if (j !== 0) {
            carry = 1;
            iq[i] = 0x1000000 - j;
          }
        } else {
          iq[i] = 0xffffff - j;
        }
      }
      if (q0 > 0) {
        if (q0 === 1) iq[jz - 1] &= 0x7fffff;
        else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
      }
      if (ih === 2) {
        z = 1 - z;
        if (carry !== 0) z -= scalbn(1, q0);
      }
    }

    // 是否需要更多位
    if (z === 0) {
      j = 0;
      for (i = jz - 1; i >= jk; i--) j |= iq[i];
      if (j === 0) {
        let k = 1;
        while (iq[jk - k] === 0) k++;
        for (i = jz + 1; i <= jz + k; i++) {
          f[jx + i] = TWO_OVER_PI[jv + i];
          let fw = 0.0;
          for (j = 0; j <= jx; j++) fw += x[j] * f[jx + i - j];
          q[i] = fw;
        }
        jz += k;
        continue;
      }
    }
    break;
  }

  if (z === 0.0) {
    jz -= 1;
    q0 -= 24;
    while (iq[jz] === 0) {
      jz--;
      q0 -= 24;
    }
  } else {
    z = scalbn(z, -q0);
    if (z >= TWO24) {
      const fw = Math.trunc(TWON24 * z);
      iq[jz] = Math.trunc(z - TWO24 * fw);
      jz += 1;
      q0 += 24;
      iq[jz] = fw;
    } else {
      iq[jz] = Math.trunc(z);
    }
  }

  let fw = scalbn(1, q0);
  for (let i = jz; i >= 0; i--) {
    q[i] = fw * iq[i];
    fw *= TWON24;
  }

  for (let i = jz; i >= 0; i--) {
    fw = 0.0;
    for (let k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * q[i + k];
    fq[jz - i] = fw;
  }

  fw = 0.0;
  for (let i = jz; i >= 0; i--) fw += fq[i];
  y[0] = ih === 0 ? fw : -fw;
  fw = fq[0] - fw;
  for (let i = 1; i <= jz; i++) fw += fq[i];
  y[1] = ih === 0 ? fw : -fw;
  return n & 7;
}

/** (n * π/2) 的高位，用于判断是否会发生抵消。 */
// prettier-ignore
const NPIO2_HW = [
  0x3ff921fb, 0x400921fb, 0x4012d97c, 0x401921fb, 0x401f6a7a, 0x4022d97c, 0x4025fdbb, 0x402921fb, 0x402c463a,
  0x402f6a7a, 0x4031475c, 0x4032d97c, 0x40346b9c, 0x4035fdbb, 0x40378fdb, 0x403921fb, 0x403ab41b, 0x403c463a,
  0x403dd85a, 0x403f6a7a, 0x40407e4c, 0x4041475c, 0x4042106c, 0x4042d97c, 0x4043a28c, 0x40446b9c, 0x404534ac,
  0x4045fdbb, 0x4046c6cb, 0x40478fdb, 0x404858eb, 0x404921fb,
];

const INVPIO2 = 6.36619772367581382433e-1; // 0x3FE45F30 6DC9C883
const PIO2_1 = 1.57079632673412561417; // 0x3FF921FB 54400000
const PIO2_1T = 6.07710050650619224932e-11; // 0x3DD0B461 1A626331
const PIO2_2 = 6.0771005063039659766e-11; // 0x3DD0B461 1A600000
const PIO2_2T = 2.02226624879595063154e-21; // 0x3BA3198A 2E037073
const PIO2_3 = 2.0222662487111664558e-21; // 0x3BA3198A 2E000000
const PIO2_3T = 8.47842766036889956997e-32; // 0x397B839A 252049C1

/** x 对 π/2 取余：x = n·π/2 + (y[0] + y[1])，返回 n（fdlibm `e_rem_pio2.c`）。 */
function remPio2(x: number, y: number[]): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    y[0] = x;
    y[1] = 0;
    return 0;
  }
  if (ix < 0x4002d97c) {
    if (hx > 0) {
      let z = x - PIO2_1;
      if (ix !== 0x3ff921fb) {
        y[0] = z - PIO2_1T;
        y[1] = z - y[0] - PIO2_1T;
      } else {
        z -= PIO2_2;
        y[0] = z - PIO2_2T;
        y[1] = z - y[0] - PIO2_2T;
      }
      return 1;
    }
    let z = x + PIO2_1;
    if (ix !== 0x3ff921fb) {
      y[0] = z + PIO2_1T;
      y[1] = z - y[0] + PIO2_1T;
    } else {
      z += PIO2_2;
      y[0] = z + PIO2_2T;
      y[1] = z - y[0] + PIO2_2T;
    }
    return -1;
  }
  if (ix <= 0x413921fb) {
    let t = Math.abs(x);
    const n = Math.trunc(t * INVPIO2 + 0.5);
    const fn = n;
    let r = t - fn * PIO2_1;
    let w = fn * PIO2_1T;
    if (n < 32 && ix !== NPIO2_HW[n - 1]) {
      y[0] = r - w;
    } else {
      const j = ix >> 20;
      y[0] = r - w;
      let i = j - ((highWord(y[0]) >> 20) & 0x7ff);
      if (i > 16) {
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - (t - r - w);
        y[0] = r - w;
        i = j - ((highWord(y[0]) >> 20) & 0x7ff);
        if (i > 49) {
          t = r;
          w = fn * PIO2_3;
          r = t - w;
          w = fn * PIO2_3T - (t - r - w);
          y[0] = r - w;
        }
      }
    }
    y[1] = r - y[0] - w;
    if (hx < 0) {
      y[0] = -y[0];
      y[1] = -y[1];
      return -n;
    }
    return n;
  }
  if (ix >= 0x7ff00000) {
    y[0] = y[1] = x - x;
    return 0;
  }
  // z = scalbn(|x|, ilogb(x) - 23)
  const e0 = (ix >> 20) - 1046;
  let z = fromWords(ix - (e0 << 20), lowWord(x));
  const tx = [0, 0, 0];
  for (let i = 0; i < 2; i++) {
    tx[i] = Math.trunc(z);
    z = (z - tx[i]) * TWO24;
  }
  tx[2] = z;
  let nx = 3;
  while (tx[nx - 1] === 0) nx--;
  const n = kernelRemPio2(tx, y, e0, nx);
  if (hx < 0) {
    y[0] = -y[0];
    y[1] = -y[1];
    return -n;
  }
  return n;
}

// ---------------------------------------------------------------------------
// sin / cos / tan
// ---------------------------------------------------------------------------

/** 正弦，弧度（fdlibm `s_sin.c`）。 */
export function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelSin(x, 0, 0);
  if (ix >= 0x7ff00000) return x - x;
  const y = [0, 0];
  const n = remPio2(x, y);
  switch (n & 3) {
    case 0:
      return kernelSin(y[0], y[1], 1);
    case 1:
      return kernelCos(y[0], y[1]);
    case 2:
      return -kernelSin(y[0], y[1], 1);
    default:
      return -kernelCos(y[0], y[1]);
  }
}

/** 余弦，弧度（fdlibm `s_cos.c`）。 */
export function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelCos(x, 0);
  if (ix >= 0x7ff00000) return x - x;
  const y = [0, 0];
  const n = remPio2(x, y);
  switch (n & 3) {
    case 0:
      return kernelCos(y[0], y[1]);
    case 1:
      return -kernelSin(y[0], y[1], 1);
    case 2:
      return -kernelCos(y[0], y[1]);
    default:
      return kernelSin(y[0], y[1], 1);
  }
}

/** 正切，弧度（fdlibm `s_tan.c`）。 */
export function tan(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) return kernelTan(x, 0, 1);
  if (ix >= 0x7ff00000) return x - x;
  const y = [0, 0];
  const n = remPio2(x, y);
  return kernelTan(y[0], y[1], 1 - ((n & 1) << 1));
}

// ---------------------------------------------------------------------------
// asin / acos / atan / atan2
// ---------------------------------------------------------------------------

const PIO2_HI = 1.570796326794896558; // 0x3FF921FB 54442D18
const PIO2_LO = 6.12323399573676603587e-17; // 0x3C91A626 33145C07
const PIO4_HI = 7.85398163397448278999e-1; // 0x3FE921FB 54442D18
const PS0 = 1.66666666666666657415e-1; // 0x3FC55555 55555555
const PS1 = -3.25565818622400915405e-1; // 0xBFD4D612 03EB6F7D
const PS2 = 2.01212532134862925881e-1; // 0x3FC9C155 0E884455
const PS3 = -4.00555345006794114027e-2; // 0xBFA48228 B5688F3B
const PS4 = 7.91534994289814532176e-4; // 0x3F49EFE0 7501B288
const PS5 = 3.4793310759602116757e-5; // 0x3F023DE1 0DFDF709
const QS1 = -2.40339491173441421878; // 0xC0033A27 1C8A2D4B
const QS2 = 2.02094576023350569471; // 0x40002AE5 9C598AC8
const QS3 = -6.8828397160545329303e-1; // 0xBFE6066C 1B8D0159
const QS4 = 7.70381505559019352791e-2; // 0x3FB3B8C5 B12E9282

const asinP = (t: number) => t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
const asinQ = (t: number) => 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));

/** 反正弦，返回弧度（fdlibm `e_asin.c`）。 */
export function asin(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | lowWord(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    if (ix < 0x3e400000) return x;
    const t = x * x;
    const w = asinP(t) / asinQ(t);
    return x + x * w;
  }
  const w = 1 - Math.abs(x);
  let t = w * 0.5;
  let p = asinP(t);
  let q = asinQ(t);
  const s = Math.sqrt(t);
  if (ix >= 0x3fef3333) {
    t = PIO2_HI - (2.0 * (s + s * (p / q)) - PIO2_LO);
  } else {
    const ww = withLowWord(s, 0);
    const c = (t - ww * ww) / (s + ww);
    const r = p / q;
    p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
    q = PIO4_HI - 2.0 * ww;
    t = PIO4_HI - (p - q);
  }
  return hx > 0 ? t : -t;
}

const PI_ = 3.141592653589793116; // 0x400921FB 54442D18

/** 反余弦，返回弧度（fdlibm `e_acos.c`）。 */
export function acos(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    if (((ix - 0x3ff00000) | lowWord(x)) === 0) {
      if (hx > 0) return 0.0;
      return PI_ + 2.0 * PIO2_LO;
    }
    return NaN;
  }
  if (ix < 0x3fe00000) {
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO;
    const z = x * x;
    const r = asinP(z) / asinQ(z);
    return PIO2_HI - (x - (PIO2_LO - x * r));
  }
  if (hx < 0) {
    const z = (1 + x) * 0.5;
    const s = Math.sqrt(z);
    const r = asinP(z) / asinQ(z);
    const w = r * s - PIO2_LO;
    return PI_ - 2.0 * (s + w);
  }
  const z = (1 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = withLowWord(s, 0);
  const c = (z - df * df) / (s + df);
  const r = asinP(z) / asinQ(z);
  const w = r * s + c;
  return 2.0 * (df + w);
}

const ATANHI = [
  4.63647609000806093515e-1, // atan(0.5)hi 0x3FDDAC67 0561BB4F
  7.85398163397448278999e-1, // atan(1.0)hi 0x3FE921FB 54442D18
  9.82793723247329054082e-1, // atan(1.5)hi 0x3FEF730B D281F69B
  1.570796326794896558, // atan(inf)hi 0x3FF921FB 54442D18
];
const ATANLO = [
  2.26987774529616870924e-17, // atan(0.5)lo 0x3C7A2B7F 222F65E2
  3.06161699786838301793e-17, // atan(1.0)lo 0x3C81A626 33145C07
  1.39033110312309984516e-17, // atan(1.5)lo 0x3C700788 7AF0CBBD
  6.12323399573676603587e-17, // atan(inf)lo 0x3C91A626 33145C07
];
const AT = [
  3.33333333333329318027e-1, // 0x3FD55555 5555550D
  -1.99999999998764832476e-1, // 0xBFC99999 9998EBC4
  1.42857142725034663711e-1, // 0x3FC24924 920083FF
  -1.1111110405462355788e-1, // 0xBFBC71C6 FE231671
  9.09088713343650656196e-2, // 0x3FB745CD C54C206E
  -7.69187620504482999495e-2, // 0xBFB3B0F2 AF749A6D
  6.66107313738753120669e-2, // 0x3FB10D66 A0D03D51
  -5.83357013379057348645e-2, // 0xBFADDE2D 52DEFD9A
  4.97687799461593236017e-2, // 0x3FA97B4B 24760DEB
  -3.6531572744216915527e-2, // 0xBFA2B444 2C6A6C2F
  1.62858201153657823623e-2, // 0x3F90AD3A E322DA11
];

/** 反正切，返回弧度（fdlibm `s_atan.c`）。 */
export function atan(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lowWord(x) !== 0)) return x + x;
    return hx > 0 ? ATANHI[3] + ATANLO[3] : -ATANHI[3] - ATANLO[3];
  }
  if (ix < 0x3fdc0000) {
    if (ix < 0x3e200000) return x;
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      if (ix < 0x3fe60000) {
        id = 0;
        x = (2.0 * x - 1) / (2.0 + x);
      } else {
        id = 1;
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      id = 2;
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3;
      x = -1.0 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
  const s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATANHI[id] - (x * (s1 + s2) - ATANLO[id] - x);
  return hx < 0 ? -r : r;
}

const PI_LO = 1.2246467991473532e-16; // 0x3CA1A626 33145C07

/** atan(y / x)，按 x、y 的符号确定象限，返回 (-π, π]。注意 y 在前（fdlibm `e_atan2.c`）。 */
export function atan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  const lx = lowWord(x);
  const hy = highWord(y);
  const iy = hy & 0x7fffffff;
  const ly = lowWord(y);
  if (((hx - 0x3ff00000) | lx) === 0) return atan(y);
  const m = ((hy >> 31) & 1) | ((hx >> 30) & 2);

  if ((iy | ly) === 0) {
    switch (m) {
      case 0:
      case 1:
        return y;
      case 2:
        return PI_ + TINY;
      default:
        return -PI_ - TINY;
    }
  }
  if ((ix | lx) === 0) return hy < 0 ? -PIO2_HI - TINY : PIO2_HI + TINY;

  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PIO4_HI + TINY;
        case 1:
          return -PIO4_HI - TINY;
        case 2:
          return 3.0 * PIO4_HI + TINY;
        default:
          return -3.0 * PIO4_HI - TINY;
      }
    }
    switch (m) {
      case 0:
        return 0;
      case 1:
        return -0;
      case 2:
        return PI_ + TINY;
      default:
        return -PI_ - TINY;
    }
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PIO2_HI - TINY : PIO2_HI + TINY;

  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) {
    z = PIO2_HI + 0.5 * PI_LO;
  } else if (hx < 0 && k < -60) {
    z = 0.0;
  } else {
    z = atan(Math.abs(y / x));
  }
  switch (m) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI_ - (z - PI_LO);
    default:
      return z - PI_LO - PI_;
  }
}

// ---------------------------------------------------------------------------
// 双曲函数与反双曲函数
// ---------------------------------------------------------------------------

/** 双曲正弦（fdlibm `e_sinh.c`）。 */
export function sinh(x: number): number {
  const jx = highWord(x);
  const ix = jx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x + x;
  const h = jx < 0 ? -0.5 : 0.5;
  if (ix < 0x40360000) {
    if (ix < 0x3e300000) return x;
    const t = expm1(Math.abs(x));
    if (ix < 0x3ff00000) return h * (2.0 * t - (t * t) / (t + 1));
    return h * (t + t / (t + 1));
  }
  if (ix < 0x40862e42) return h * exp(Math.abs(x));
  const lx = lowWord(x);
  if (ix < 0x408633ce || (ix === 0x408633ce && lx <= 0x8fb9f87d)) {
    const w = exp(0.5 * Math.abs(x));
    const t = h * w;
    return t * w;
  }
  return x * 1.0e307;
}

/** 双曲余弦（fdlibm `e_cosh.c`）。 */
export function cosh(x: number): number {
  const ix = highWord(x) & 0x7fffffff;
  if (ix >= 0x7ff00000) return x * x;
  if (ix < 0x3fd62e43) {
    const t = expm1(Math.abs(x));
    const w = 1 + t;
    if (ix < 0x3c800000) return w;
    return 1 + (t * t) / (w + w);
  }
  if (ix < 0x40360000) {
    const t = exp(Math.abs(x));
    return 0.5 * t + 0.5 / t;
  }
  if (ix < 0x40862e42) return 0.5 * exp(Math.abs(x));
  const lx = lowWord(x);
  if (ix < 0x408633ce || (ix === 0x408633ce && lx <= 0x8fb9f87d)) {
    const w = exp(0.5 * Math.abs(x));
    const t = 0.5 * w;
    return t * w;
  }
  return HUGE * HUGE;
}

/** 双曲正切（fdlibm `s_tanh.c`）。 */
export function tanh(x: number): number {
  const jx = highWord(x);
  const ix = jx & 0x7fffffff;
  if (ix >= 0x7ff00000) {
    if (jx >= 0) return 1 / x + 1;
    return 1 / x - 1;
  }
  let z: number;
  if (ix < 0x40360000) {
    if (ix < 0x3c800000) return x * (1 + x);
    if (ix >= 0x3ff00000) {
      const t = expm1(2 * Math.abs(x));
      z = 1 - 2 / (t + 2);
    } else {
      const t = expm1(-2 * Math.abs(x));
      z = -t / (t + 2);
    }
  } else {
    z = 1 - TINY;
  }
  return jx >= 0 ? z : -z;
}

const LN2 = 6.93147180559945286227e-1; // 0x3FE62E42 FEFA39EF

/** 反双曲正弦（fdlibm `s_asinh.c`）。 */
export function asinh(x: number): number {
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x7ff00000) return x + x;
  if (ix < 0x3e300000) return x;
  let w: number;
  if (ix > 0x41b00000) {
    w = log(Math.abs(x)) + LN2;
  } else if (ix > 0x40000000) {
    const t = Math.abs(x);
    w = log(2.0 * t + 1 / (Math.sqrt(x * x + 1) + t));
  } else {
    const t = x * x;
    w = log1p(Math.abs(x) + t / (1 + Math.sqrt(1 + t)));
  }
  return hx > 0 ? w : -w;
}

/** 反双曲余弦，x >= 1（fdlibm `e_acosh.c`）。 */
export function acosh(x: number): number {
  const hx = highWord(x);
  if (hx < 0x3ff00000) return NaN;
  if (hx >= 0x41b00000) {
    if (hx >= 0x7ff00000) return x + x;
    return log(x) + LN2;
  }
  if (((hx - 0x3ff00000) | lowWord(x)) === 0) return 0.0;
  if (hx > 0x40000000) {
    const t = x * x;
    return log(2.0 * x - 1 / (x + Math.sqrt(t - 1)));
  }
  const t = x - 1;
  return log1p(t + Math.sqrt(2.0 * t + t * t));
}

/** 反双曲正切，|x| < 1（fdlibm `e_atanh.c`）。 */
export function atanh(x: number): number {
  if (x !== x) return x + x;
  const hx = highWord(x);
  const ix = hx & 0x7fffffff;
  const ax = Math.abs(x);
  if (ax > 1) return NaN;
  if (ax === 1) return x / 0;
  if (ix < 0x3e300000) return x;
  let t: number;
  if (ix < 0x3fe00000) {
    t = ax + ax;
    t = 0.5 * log1p(t + (t * ax) / (1 - ax));
  } else {
    t = 0.5 * log1p((ax + ax) / (1 - ax));
  }
  return hx >= 0 ? t : -t;
}

// ---------------------------------------------------------------------------
// hypot / pow
// ---------------------------------------------------------------------------

/** sqrt(x² + y²)，不会中途溢出（fdlibm `e_hypot.c`）。 */
export function hypot(x: number, y: number): number {
  let ha = highWord(x) & 0x7fffffff;
  let hb = highWord(y) & 0x7fffffff;
  let a: number;
  let b: number;
  if (hb > ha) {
    a = y;
    b = x;
    const j = ha;
    ha = hb;
    hb = j;
  } else {
    a = x;
    b = y;
  }
  a = withHighWord(a, ha);
  b = withHighWord(b, hb);
  if (ha - hb > 0x3c00000) return a + b;
  let k = 0;
  if (ha > 0x5f300000) {
    if (ha >= 0x7ff00000) {
      let w = a + b;
      if (((ha & 0xfffff) | lowWord(a)) === 0) w = a;
      if (((hb ^ 0x7ff00000) | lowWord(b)) === 0) w = b;
      return w;
    }
    ha -= 0x25800000;
    hb -= 0x25800000;
    k += 600;
    a = withHighWord(a, ha);
    b = withHighWord(b, hb);
  }
  if (hb < 0x20b00000) {
    if (hb <= 0x000fffff) {
      if ((hb | lowWord(b)) === 0) return a;
      const t1 = fromWords(0x7fd00000, 0); // 2^1022
      b *= t1;
      a *= t1;
      k -= 1022;
    } else {
      ha += 0x25800000;
      hb += 0x25800000;
      k -= 600;
      a = withHighWord(a, ha);
      b = withHighWord(b, hb);
    }
  }
  let w = a - b;
  if (w > b) {
    const t1 = fromWords(ha, 0);
    const t2 = a - t1;
    w = Math.sqrt(t1 * t1 - (b * -b - t2 * (a + t1)));
  } else {
    a = a + a;
    const y1 = fromWords(hb, 0);
    const y2 = b - y1;
    const t1 = fromWords(ha + 0x00100000, 0);
    const t2 = a - t1;
    w = Math.sqrt(t1 * y1 - (w * -w - (t1 * y2 + t2 * b)));
  }
  if (k !== 0) return fromWords(0x3ff00000 + (k << 20), 0) * w;
  return w;
}

const BP = [1.0, 1.5];
const DP_H = [0.0, 5.84962487220764160156e-1]; // 0x3FE2B803 40000000
const DP_L = [0.0, 1.35003920212974897128e-8]; // 0x3E4CFDEB 43CFD006
const TWO53 = 9007199254740992.0; // 0x43400000 00000000
const L1 = 5.99999999999994648725e-1; // 0x3FE33333 33333303
const L2 = 4.28571428578550184252e-1; // 0x3FDB6DB6 DB6FABFF
const L3 = 3.33333329818377432918e-1; // 0x3FD55555 518F264D
const L4 = 2.72728123808534006489e-1; // 0x3FD17460 A91D4101
const L5 = 2.30660745775561754067e-1; // 0x3FCD864A 93C9DB65
const L6 = 2.06975017800338417784e-1; // 0x3FCA7E28 4A454EEF
const LG2_ = 6.93147180559945286227e-1; // 0x3FE62E42 FEFA39EF
const LG2_H = 6.93147182464599609375e-1; // 0x3FE62E43 00000000
const LG2_L = -1.90465429995776804525e-9; // 0xBE205C61 0CA86C39
const OVT = 8.008566259537294e-17; // -(1024-log2(ovfl+.5ulp))
const CP = 9.61796693925975554329e-1; // 0x3FEEC709 DC3A03FD = 2/(3ln2)
const CP_H = 9.61796700954437255859e-1; // 0x3FEEC709 E0000000
const CP_L = -7.02846165095275826516e-9; // 0xBE3E2FE0 145B01F5
const IVLN2 = 1.442695040888963387; // 0x3FF71547 652B82FE
const IVLN2_H = 1.44269502162933349609; // 0x3FF71547 60000000
const IVLN2_L = 1.92596299112661746887e-8; // 0x3E54AE0B F85DDF44

/** x 的 y 次方（fdlibm `e_pow.c`）。 */
export function pow(x: number, y: number): number {
  const hx = highWord(x);
  const lx = lowWord(x);
  const hy = highWord(y);
  const ly = lowWord(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  if ((iy | ly) === 0) return 1;

  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) {
    return x + y;
  }

  // yisint：0 不是整数，1 奇数，2 偶数
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) {
      yisint = 2;
    } else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if ((j << (52 - k)) >>> 0 === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }

  if (ly === 0) {
    if (iy === 0x7ff00000) {
      if (((ix - 0x3ff00000) | lx) === 0) return y - y;
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0;
      return hy < 0 ? -y : 0;
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x;
    if (hy === 0x40000000) return x * x;
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x);
  }

  let ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    let z = ax;
    if (hy < 0) z = 1 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0) z = NaN;
      else if (yisint === 1) z = -z;
    }
    return z;
  }

  let n = (hx >> 31) + 1;
  if ((n | yisint) === 0) return NaN;

  let s = 1;
  if ((n | (yisint - 1)) === 0) s = -1;

  let t1: number;
  let t2: number;
  if (iy > 0x41e00000) {
    if (iy > 0x43f00000) {
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
    const t = ax - 1;
    const w = t * t * (0.5 - t * (0.3333333333333333 - t * 0.25));
    const u = IVLN2_H * t;
    const v = t * IVLN2_L - w * IVLN2;
    t1 = withLowWord(u + v, 0);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00100000) {
      ax *= TWO53;
      n -= 53;
      ix = highWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    ix = j | 0x3ff00000;
    let k: number;
    if (j <= 0x3988e) {
      k = 0;
    } else if (j < 0xbb67a) {
      k = 1;
    } else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = withHighWord(ax, ix);

    let u = ax - BP[k];
    let v = 1 / (ax + BP[k]);
    const ss = u * v;
    const sh = withLowWord(ss, 0);
    let th = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let tl = ax - (th - BP[k]);
    const sl = v * (u - sh * th - sh * tl);
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sl * (sh + ss);
    s2 = sh * sh;
    th = withLowWord(3.0 + s2 + r, 0);
    tl = r - (th - 3.0 - s2);
    u = sh * th;
    v = sl * th + tl * ss;
    const ph = withLowWord(u + v, 0);
    const pl = v - (ph - u);
    const zh = CP_H * ph;
    const zl = CP_L * ph + pl * CP + DP_L[k];
    const t = n;
    t1 = withLowWord(zl + zh + DP_H[k] + t, 0);
    t2 = zl - (t1 - t - DP_H[k] - zh);
  }

  // (y1 + y2) * (t1 + t2)
  const y1 = withLowWord(y, 0);
  const pl = (y - y1) * t1 + y * t2;
  let ph = y1 * t1;
  let z = pl + ph;
  let j = highWord(z);
  let i = lowWord(z);
  if (j >= 0x40900000) {
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE;
    if (pl + OVT > z - ph) return s * HUGE * HUGE;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    if (((j - (0xc090cc00 | 0)) | i) !== 0) return s * TINY * TINY;
    if (pl <= z - ph) return s * TINY * TINY;
  }

  // 2^(ph + pl)
  i = j & 0x7fffffff;
  let k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) {
    n = j + (0x00100000 >> (k + 1));
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = fromWords(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    ph -= t;
  }
  const t = withLowWord(pl + ph, 0);
  const u = t * LG2_H;
  const v = (pl - (t - ph)) * LG2_ + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const tt1 = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tt1) / (tt1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = highWord(z);
  j += n << 20;
  if (j >> 20 <= 0) z = scalbn(z, n);
  else z = withHighWord(z, j);
  return s * z;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 确定性数学函数集合，用法与 `Math` 相同。钩子的 `ctx.math`、`Era.math` 与 `开发工具/era.ts` 导出的都是它。
 * 规范要求精确结果的函数（`sqrt`、`abs`、`floor` 等）直接使用原生实现。
 */
export const detMath = Object.freeze({
  PI: Math.PI,
  E: Math.E,
  exp,
  expm1,
  log,
  log1p,
  log2,
  log10,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  atan2,
  sinh,
  cosh,
  tanh,
  asinh,
  acosh,
  atanh,
  hypot,
  pow,
  sqrt: Math.sqrt,
  abs: Math.abs,
  sign: Math.sign,
  floor: Math.floor,
  ceil: Math.ceil,
  trunc: Math.trunc,
  round: Math.round,
  min: Math.min,
  max: Math.max,
});

export type DetMath = typeof detMath;
