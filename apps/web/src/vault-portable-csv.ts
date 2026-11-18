const headers = [
  "folder",
  "favorite",
  "type",
  "name",
  "notes",
  "fields",
  "reprompt",
  "archivedDate",
  "login_uri",
  "login_username",
  "login_password",
  "login_totp",
] as const;

export const readCsv = (text: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let state: "start" | "text" | "quoted" | "closed" = "start";
  const endValue = () => {
    row.push(value);
    state = "start";
    value = "";
  };
  const endRow = () => {
    endValue();
    if (row.length > 1 || row[0]) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (state === "quoted") {
      if (char !== '"') value += char;
      else if (text[i + 1] === '"') {
        value += '"';
        i++;
      } else state = "closed";
    } else if (char === ",") endValue();
    else if (char === "\r" || char === "\n") {
      endRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (state === "start" && char === '"') state = "quoted";
    else {
      if (state === "closed" || char === '"')
        throw new Error("The CSV contains invalid quoting.");
      state = "text";
      value += char;
    }
  }
  if (state === "quoted")
    throw new Error("The CSV contains an unclosed quote.");
  if (value !== "" || row.length || state === "closed") endRow();
  return rows;
};

const writeRow = (row: readonly (string | number | null | undefined)[]) =>
  row
    .map((value) => {
      const text = value?.toString() ?? "";
      return /[,"\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    })
    .join(",");

export const writeVaultCsv = (
  rows: readonly Record<string, string | number | null | undefined>[],
) =>
  [
    writeRow(headers),
    ...rows.map((row) => writeRow(headers.map((header) => row[header]))),
  ].join("\r\n");

export const csvExportUris = (uris: readonly (string | null)[]) =>
  writeRow(uris);

export const readVaultCsv = (text: string) => {
  const [columns, ...rows] = readCsv(text);
  if (
    !columns ||
    !columns.includes("type") ||
    !columns.includes("name") ||
    new Set(columns).size !== columns.length ||
    columns.some(
      (header) => !headers.includes(header as (typeof headers)[number]),
    )
  )
    throw new Error("Choose a personal Bitwarden CSV export.");

  const folders = new Map<string, { id: string; name: string }>();
  const items = rows.map((values, index) => {
    if (values.length !== columns.length)
      throw new Error(`CSV row ${index + 2} has the wrong number of columns.`);
    const row = Object.fromEntries(
      columns.map((column, i) => [column, values[i]!]),
    );
    if (row.type !== "login" && row.type !== "note")
      throw new Error(`CSV row ${index + 2} has an unsupported item type.`);
    if (row.folder && !folders.has(row.folder))
      folders.set(row.folder, { id: crypto.randomUUID(), name: row.folder });
    return {
      type: row.type === "login" ? 1 : 2,
      folderId: row.folder ? folders.get(row.folder)!.id : null,
      name: row.name,
      favorite: !!row.favorite && row.favorite !== "0",
      notes: row.notes || null,
      reprompt: row.reprompt ? Number(row.reprompt) : 0,
      archivedDate: row.archivedDate || null,
      fields: (row.fields ?? "")
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((field) => {
          const delimiter = field.lastIndexOf(": ");
          return delimiter < 0
            ? { type: 0, name: field, value: null }
            : {
                type: 0,
                name: field.slice(0, delimiter),
                value: field.slice(delimiter + 2),
              };
        }),
      ...(row.type === "login"
        ? {
            login: {
              username: row.login_username || null,
              password: row.login_password || null,
              totp: row.login_totp || null,
              uris:
                readCsv(row.login_uri ?? "")[0]?.map((uri) => ({
                  uri,
                  match: null,
                })) ?? [],
            },
          }
        : { secureNote: { type: 0 } }),
    };
  });
  return { encrypted: false, folders: [...folders.values()], items };
};
