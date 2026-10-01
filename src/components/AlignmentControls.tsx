import { useState } from "react";
type Alignment = {
    lateralMeters: number;
    yawRad: number;
};
export function AlignmentControls({ initial = { lateralMeters: 0, yawRad: 0 }, onChange, onLock, lockDisabled = false }: {
    initial?: Alignment;
    onChange: (v: Alignment) => void;
    onLock: () => void;
    lockDisabled?: boolean;
}) {
    const [value, setValue] = useState(initial);
    const change = (next: Alignment) => { setValue(next); onChange(next); };
    return <div className="alignment-controls">
  <p>Match the ghost markers to the path, then lock the alignment.</p>
  <label>Shift left / right<input aria-label="Lateral alignment" type="range" min="-1" max="1" step="0.05" value={value.lateralMeters} onChange={e => change({ ...value, lateralMeters: Number(e.target.value) })}/></label>
  <label>Small rotation<input aria-label="Yaw alignment" type="range" min="-3" max="3" step="0.25" value={value.yawRad * 180 / Math.PI} onChange={e => change({ ...value, yawRad: Number(e.target.value) * Math.PI / 180 })}/></label>
  <button type="button" className="text-button" onClick={() => change({ lateralMeters: 0, yawRad: 0 })}>Reset alignment</button>
  <button type="button" disabled={lockDisabled} onClick={onLock}>Lock alignment</button>
 </div>;
}
