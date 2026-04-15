/**
 * Off-main-thread merge of instance customColor/customOpacity readback into SH DC + opacity.
 * Must match `getPaintFromGpu` in main.js (same SH_C0, blend cases, erase formula).
 */
const SH_C0 = 0.28209479177387814;
const sigmoid = (v) => 1 / (1 + Math.exp(-v));
const invSigmoid = (v) => -Math.log(1 / Math.max(1e-6, Math.min(1 - 1e-6, v)) - 1);

self.onmessage = (e) => {
    const { id, n, w, h, curBlend } = e.data;
    try {
        const colorData = new Uint8Array(e.data.colorBuffer);
        const opacityData = new Uint8Array(e.data.opacityBuffer);
        const fdc0 = new Float32Array(e.data.f0Buffer);
        const fdc1 = new Float32Array(e.data.f1Buffer);
        const fdc2 = new Float32Array(e.data.f2Buffer);
        const opacity = new Float32Array(e.data.opBuffer);

        if (fdc0.length !== n || fdc1.length !== n || fdc2.length !== n || opacity.length !== n) {
            throw new Error('fdc length mismatch');
        }

        const out0 = new Float32Array(fdc0);
        const out1 = new Float32Array(fdc1);
        const out2 = new Float32Array(fdc2);
        const outOp = new Float32Array(opacity);

        const texMax = w * h - 1;
        for (let i = 0; i < n; i++) {
            const off = Math.min(i, texMax) * 4;
            const cr = colorData[off] / 255;
            const cg = colorData[off + 1] / 255;
            const cb = colorData[off + 2] / 255;
            const ca = colorData[off + 3] / 255;
            const ea = opacityData[off + 3] / 255;
            const origR = 0.5 + fdc0[i] * SH_C0;
            const origG = 0.5 + fdc1[i] * SH_C0;
            const origB = 0.5 + fdc2[i] * SH_C0;
            if (ca > 0) {
                let fR;
                let fG;
                let fB;
                switch (curBlend) {
                    case 1:
                        fR = origR + (origR * cr - origR) * ca;
                        fG = origG + (origG * cg - origG) * ca;
                        fB = origB + (origB * cb - origB) * ca;
                        break;
                    case 2:
                        fR = origR + (Math.max(origR, cr) - origR) * ca;
                        fG = origG + (Math.max(origG, cg) - origG) * ca;
                        fB = origB + (Math.max(origB, cb) - origB) * ca;
                        break;
                    case 3:
                        fR = origR + (Math.min(origR, cr) - origR) * ca;
                        fG = origG + (Math.min(origG, cg) - origG) * ca;
                        fB = origB + (Math.min(origB, cb) - origB) * ca;
                        break;
                    default:
                        fR = origR + (cr - origR) * ca;
                        fG = origG + (cg - origG) * ca;
                        fB = origB + (cb - origB) * ca;
                }
                out0[i] = (fR - 0.5) / SH_C0;
                out1[i] = (fG - 0.5) / SH_C0;
                out2[i] = (fB - 0.5) / SH_C0;
            }
            if (ea > 0) {
                outOp[i] = invSigmoid(sigmoid(opacity[i]) * (1 - Math.min(1, ea)));
            }
        }

        self.postMessage(
            { id, out0: out0.buffer, out1: out1.buffer, out2: out2.buffer, outOp: outOp.buffer },
            [out0.buffer, out1.buffer, out2.buffer, outOp.buffer],
        );
    } catch (err) {
        self.postMessage({ id, error: err?.message || String(err) });
    }
};
