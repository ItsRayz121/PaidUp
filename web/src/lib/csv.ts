// Tiny CSV reader for the staff console's disbursement reconcile upload
// (founder, 2026-09-02). The API takes JSON, not a file — the browser parses
// the CSV here and POSTs rows, so no multipart dependency is added server-side.
//
// Handles: quoted fields, "" escapes inside quotes, CRLF or LF line endings, a
// trailing newline, and a BOM. Not a general CSV library — it does exactly what
// the disbursement round-trip needs and nothing more.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // Strip a UTF-8 BOM if the file has one.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  // Flush the last field/row unless the file ended on a clean newline.
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Parse into objects keyed by the header row. Header names are lower-cased and
// trimmed so "Tx Hash", "tx_hash" and "txhash" all land somewhere predictable
// — the caller maps from there.
export function parseCsvRecords(text: string): Record<string, string>[] {
  const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (grid.length < 2) return [];
  const header = grid[0].map((h) => h.trim().toLowerCase());
  return grid.slice(1).map((cells) => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = (cells[i] ?? "").trim(); });
    return rec;
  });
}

// Pull { disbursementId, txHash } pairs out of a reconcile upload, tolerating
// the common header spellings. Rows with neither value are dropped.
export function reconcileRowsFromCsv(text: string): { disbursementId: string; txHash: string }[] {
  const key = (rec: Record<string, string>, names: string[]) => {
    for (const n of names) if (rec[n]) return rec[n];
    return "";
  };
  return parseCsvRecords(text)
    .map((rec) => ({
      disbursementId: key(rec, ["disbursement_id", "disbursementid", "id"]),
      txHash: key(rec, ["tx_hash", "txhash", "tx hash", "hash", "transaction_hash"]),
    }))
    .filter((r) => r.disbursementId && r.txHash);
}
