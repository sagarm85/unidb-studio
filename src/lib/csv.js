// Minimal RFC-4180-ish CSV parser: handles quoted fields, embedded commas,
// embedded newlines, and "" escaped quotes. Enough for demo-sized uploads.
// Returns { headers: string[], rows: string[][] }.

export function parseCsv(text) {
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ',') {
      pushField();
      i++;
    } else if (ch === '\r') {
      i++; // swallow, \n handles the record break
    } else if (ch === '\n') {
      pushRecord();
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  // Trailing field/record if the file doesn't end in a newline.
  if (field.length > 0 || record.length > 0) pushRecord();

  // Drop fully-empty trailing records (blank lines at EOF).
  while (records.length && records[records.length - 1].every((c) => c === '')) {
    records.pop();
  }

  if (!records.length) return { headers: [], rows: [] };
  const [headers, ...rows] = records;
  return { headers, rows };
}
