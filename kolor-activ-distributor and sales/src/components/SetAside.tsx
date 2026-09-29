import { plural } from "../lib/supabase";

/** Stock files put aside during an upload, to come back to later. They stay while the app is open. */
export default function SetAside({ files, onOpen, onRemove }: { files: { file: File; reason: string }[]; onOpen: (f: File) => void; onRemove: (f: File) => void }) {
  return <section className="card">
    <div className="rowhead"><h2>Set Aside ({files.length})</h2></div>
    <p className="hint">{plural(files.length, "file")} put aside so the rest could be saved. Open one when you're ready to deal with it. They're kept until you close or reload the app.</p>
    <div className="tablewrap"><table className="nice"><thead><tr><th>File</th><th>Why</th><th /></tr></thead>
      <tbody>{files.map(x => <tr key={x.file.name + x.file.lastModified}><td><b>{x.file.name}</b></td><td className="wrap">{x.reason}</td>
        <td className="actions"><button className="small" onClick={() => onOpen(x.file)}>Open</button><button className="secondary small" onClick={() => onRemove(x.file)}>Remove</button></td></tr>)}</tbody></table></div>
  </section>;
}
