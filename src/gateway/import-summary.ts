export type ImportSummary = {
  imported: number;
  database: string;
};

export function importSummary(imported: number, database: string): ImportSummary {
  return { imported, database };
}
