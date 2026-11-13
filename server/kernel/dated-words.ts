// Why a dated sheet's row in force can't be changed or deleted (M30). Pure, so the record panel can say it too.
type Named = { row?: { one: string; many: string } | null };

export const keptInForce = (sheet: Named) => {
  const many = sheet.row?.many ?? "rows";
  return `${many.charAt(0).toUpperCase() + many.slice(1)} already in force can't be changed. Add a new one from the date it changes.`;
};
