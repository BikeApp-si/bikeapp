import countryToCurrency from "country-to-currency";

// Countries and currencies for Settings (M26), named in English by Intl. Only currencies with cents (two minor
// digits) are offered: money is stored in cents.

const CURRENCY = countryToCurrency as Record<string, string>;
const regionNames = new Intl.DisplayNames("en", { type: "region" });
const currencyNames = new Intl.DisplayNames("en", { type: "currency" });

export const isCountry = (code: string) => code in CURRENCY;
export const currencyOf = (country: string): string | null => CURRENCY[country] ?? null;

const hasCents = (code: string) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits === 2;
  } catch {
    return false;
  }
};

export const CURRENCIES: string[] = [...new Set(Object.values(CURRENCY))].filter(hasCents).sort();
export const isCurrency = (code: string) => CURRENCIES.includes(code);

export function countryChoices(): { id: string; label: string }[] {
  return Object.keys(CURRENCY)
    .map((id) => ({ id, label: regionNames.of(id) ?? id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// "INR · Indian Rupee"
export function currencyChoices(): { id: string; label: string }[] {
  return CURRENCIES.map((id) => ({ id, label: `${id} · ${currencyNames.of(id) ?? id}` }));
}
