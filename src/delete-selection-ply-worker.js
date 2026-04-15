/**
 * Off-main-thread binary PLY encoder for compacted Gaussian splats.
 * Matches the column order Photoshock passes (same layout writePly would emit as float props).
 */
self.onmessage = (e) => {
    const { id, names, rowCount, buffers } = e.data;
    try {
        if (!names?.length || !buffers?.length || names.length !== buffers.length) {
            throw new Error('invalid ply worker payload');
        }
        const arrays = buffers.map((b) => new Float32Array(b));
        for (let p = 0; p < arrays.length; p++) {
            if (arrays[p].length !== rowCount) {
                throw new Error(`column ${names[p]} length ${arrays[p].length} !== ${rowCount}`);
            }
        }

        const headerLines = ['ply', 'format binary_little_endian 1.0', `element vertex ${rowCount}`];
        for (const name of names) {
            headerLines.push(`property float ${name}`);
        }
        headerLines.push('end_header');
        const headerText = headerLines.join('\n') + '\n';
        const header = new TextEncoder().encode(headerText);
        const props = names.length;
        const bodySize = rowCount * props * 4;
        const total = header.byteLength + bodySize;
        const out = new ArrayBuffer(total);
        new Uint8Array(out, 0, header.byteLength).set(header);
        const dv = new DataView(out, header.byteLength, bodySize);
        let o = 0;
        for (let i = 0; i < rowCount; i++) {
            for (let p = 0; p < props; p++) {
                dv.setFloat32(o, arrays[p][i], true);
                o += 4;
            }
        }
        self.postMessage({ id, buffer: out }, [out]);
    } catch (err) {
        self.postMessage({ id, error: err?.message || String(err) });
    }
};
