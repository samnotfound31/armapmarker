import type { CameraIntrinsics, Mat3, Mat4 } from "../domain/types";
import { invertHomography, multiplyHomographies, normalizeHomography } from "../tracking/residualHomography";
export const IDENTITY_REGISTRATION: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** Column-vector ground coordinates [east,north,1]; keep N unnormalized (h33 can be zero). */
export function nominalGroundProjection(m: Mat4, k: CameraIntrinsics): Mat3 {
    return multiplyHomographies([k.fxPx, 0, 0, 0, k.fyPx, 0, k.cxPx, k.cyPx, 1], [m[0], m[1], m[2], m[8], m[9], m[10], m[12], m[13], m[14]]);
}
export function residualFromGroundMotion(observed: Mat3, referenceCorrection: Mat3, referenceNominal: Mat3, currentNominal: Mat3): Mat3 {
    return normalizeHomography(multiplyHomographies(observed, multiplyHomographies(referenceCorrection, multiplyHomographies(referenceNominal, invertHomography(currentNominal)))));
}
export function transportCorrection(correction: Mat3, measuredNominal: Mat3, currentNominal: Mat3): Mat3 {
    const predicted = multiplyHomographies(currentNominal, invertHomography(measuredNominal));
    return normalizeHomography(multiplyHomographies(predicted, multiplyHomographies(correction, multiplyHomographies(measuredNominal, invertHomography(currentNominal)))));
}
export function warp(h: Mat3, x: number, y: number): [
    number,
    number
] { const d = h[2] * x + h[5] * y + h[8]; if (!Number.isFinite(d) || Math.abs(d) < 1e-8)
    throw new RangeError("Registration crosses its projective horizon."); return [(h[0] * x + h[3] * y + h[6]) / d, (h[1] * x + h[4] * y + h[7]) / d]; }
export function registrationDistance(a: Mat3, b: Mat3, width: number, height: number): number {
    return Math.max(...[[.15, .6], [.85, .6], [.15, .9], [.85, .9], [.5, .75]].map(([x, y]) => { const p = warp(a, x! * width, y! * height), q = warp(b, x! * width, y! * height); return Math.hypot(p[0] - q[0], p[1] - q[1]); }));
}
/** Filter innovations in image control-point space, then solve the projective mapping. */
export function blendRegistration(a: Mat3, b: Mat3, gain: number, w: number, h: number): Mat3 {
    const rows: number[][] = [];
    for (const [x, y] of [[.15 * w, .6 * h], [.85 * w, .6 * h], [.85 * w, .9 * h], [.15 * w, .9 * h]]) {
        const p = warp(a, x!, y!), q = warp(b, x!, y!);
        const u = p[0] + gain * (q[0] - p[0]), v = p[1] + gain * (q[1] - p[1]);
        rows.push([x!, y!, 1, 0, 0, 0, -u * x!, -u * y!, u], [0, 0, 0, x!, y!, 1, -v * x!, -v * y!, v]);
    }
    for (let col = 0; col < 8; col++) {
        let pivot = col;
        for (let i = col + 1; i < 8; i++)
            if (Math.abs(rows[i]![col]!) > Math.abs(rows[pivot]![col]!))
                pivot = i;
        [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
        const d = rows[col]![col]!;
        if (Math.abs(d) < 1e-10)
            throw new RangeError("Registration control points are singular.");
        for (let j = col; j <= 8; j++)
            rows[col]![j] = rows[col]![j]! / d;
        for (let i = 0; i < 8; i++)
            if (i !== col) {
                const f = rows[i]![col]!;
                for (let j = col; j <= 8; j++)
                    rows[i]![j] = rows[i]![j]! - f * rows[col]![j]!;
            }
    }
    const v = rows.map(row => row[8]!);
    return [v[0]!, v[3]!, v[6]!, v[1]!, v[4]!, v[7]!, v[2]!, v[5]!, 1];
}
