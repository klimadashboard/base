/**
 * Target datasets an uploader may update. Claude picks one of these per extracted
 * table; the server then validates rows against `categories` and `period`
 * and upserts them into `collection` using `keyFields`.
 *
 * To add a dataset: add an entry here; grants in data_upload_access with an
 * empty dataset list pick it up automatically.
 */
import type { Target } from "./access";

export type PeriodKind = "year" | "year_string" | "month_end";

export type Dataset = {
	id: string;
	label: string;
	collection: string;
	/** Field holding the period; written as integer, "YYYY" string or "YYYY-MM-DD". */
	periodField: string;
	periodKind: PeriodKind;
	categories: string[];
	unit: string;
	/** Fields that identify a row (besides period + category, which are always part of the key). */
	fixedFields: (target: Target) => Record<string, string | number>;
	/** "date" for date columns, "datetime" for timestamp columns; omit if the collection has none. */
	updateField?: { name: string; type: "date" | "datetime" };
	/** Instructions for Claude: what the table looks like, how to map it. */
	guidance: string;
};

export const DATASETS: Dataset[] = [
	{
		id: "pkw_neuzulassungen",
		label: "Pkw-Neuzulassungen nach Antriebsart",
		collection: "mobility_cars_registrations",
		periodField: "period",
		periodKind: "month_end",
		categories: ["Benzin", "Diesel", "Hybrid", "Plug-in-Hybrid", "Elektro", "Sonstige"],
		unit: "Anzahl Pkw",
		fixedFields: (t) => ({ region: t.id, country: t.country }),
		updateField: { name: "update", type: "date" },
		guidance: `Monthly new passenger car registrations by fuel type.
- Values are CUMULATIVE since 1 January of the same year (year-to-date), exactly as published. Do NOT convert them to monthly increments.
- period = last day of the reporting month as YYYY-MM-DD (e.g. "Ende September 2026" -> 2026-09-30).
- Use only the "Neuzulassungen" columns (absolute numbers, not percentages). Ignore "Bestand"/"Pkw insgesamt" columns — those are a different dataset.
- Category mapping: Benzin -> Benzin, Diesel -> Diesel, Hybrid (ohne Plug-in) -> Hybrid, Plug-in-Hybrid -> Plug-in-Hybrid, Elektro (BEV) -> Elektro.
- Sonstige = SUM of every remaining fuel type: Brennstoffzelle + Flüssiggas + Erdgas + Sonstige (Ethanol, Wasserstoff, ...). Do this sum yourself and mention it in notes.
- Do not emit a total row. The six categories must add up to the published total ("Pkw insgesamt") — check this and report any mismatch as a warning.`,
	},
	{
		id: "pkw_bestand",
		label: "Pkw-Bestand nach Antriebsart",
		collection: "mobility_cars",
		periodField: "period",
		periodKind: "month_end",
		categories: ["Benzin", "Diesel", "Hybrid", "Plug-in-Hybrid", "Elektro", "Sonstige"],
		unit: "Anzahl Pkw",
		// mobility_cars keys regions by their official code, not by uuid
		fixedFields: (t) => ({ region: t.ags, country: t.country }),
		guidance: `Registered passenger cars (stock, "Bestand") by fuel type at the end of a month.
- Values are the stock on the reporting date, NOT new registrations. Use only the "Bestand" columns (absolute numbers, not percentages); ignore "Neuzulassungen" columns — those are a different dataset (pkw_neuzulassungen).
- period = last day of the reporting month as YYYY-MM-DD (e.g. "Stand 31.08.2026" -> 2026-08-31).
- Category mapping: Benzin -> Benzin, Diesel -> Diesel, Hybrid (ohne Plug-in) -> Hybrid, Plug-in-Hybrid -> Plug-in-Hybrid, Elektro (BEV) -> Elektro.
- Sonstige = SUM of every remaining fuel type: Brennstoffzelle + Flüssiggas + Erdgas + Sonstige (Ethanol, Wasserstoff, ...). Do this sum yourself and mention it in notes.
- Do not emit a total row. The six categories must add up to the published total ("Pkw insgesamt") — check this and report any mismatch as a warning.
- The stock changes slowly: month-to-month changes above ~2% in a category are suspicious, report them as a warning.`,
	},
	{
		id: "thg_bisko",
		label: "THG-Emissionen nach BISKO-Sektoren",
		collection: "emissions_data",
		periodField: "year",
		periodKind: "year",
		categories: [
			"bisko_ghd",
			"bisko_industrie",
			"bisko_staedtliegenschaften",
			"bisko_verkehr",
			"bisko_wohnen",
		],
		unit: "t CO2eq",
		fixedFields: (t) => ({ region: t.id, gas: "THG" }),
		updateField: { name: "update", type: "datetime" },
		guidance: `Annual greenhouse gas emissions of the city by BISKO sector, in tonnes CO2-equivalent.
- Convert kt or Mio. t to t (1 kt = 1000 t).
- Sector mapping: Gewerbe/Handel/Dienstleistungen (GHD) -> bisko_ghd, Industrie -> bisko_industrie, Städtische Liegenschaften/Kommunale Einrichtungen -> bisko_staedtliegenschaften, Verkehr -> bisko_verkehr, Private Haushalte/Wohnen -> bisko_wohnen.
- Do not emit totals.`,
	},
	{
		id: "modal_split",
		label: "Modal Split (Anteil der Wege)",
		collection: "mobility_modal_split",
		periodField: "year",
		periodKind: "year",
		categories: [
			"on_foot",
			"bicycle",
			"e_bike",
			"public_transport",
			"motorbike",
			"car_driver",
			"car_passenger",
		],
		unit: "% der Wege",
		fixedFields: (t) => ({ region: t.id }),
		updateField: { name: "update", type: "date" },
		guidance: `Share of trips by transport mode in percent (0-100).
- Mapping: zu Fuß -> on_foot, Fahrrad -> bicycle, Pedelec/E-Bike -> e_bike, ÖPNV/Bus & Bahn -> public_transport, Motorrad/Krad -> motorbike, Pkw-Fahrer -> car_driver, Pkw-Mitfahrer -> car_passenger.
- If e-bikes are not reported separately, omit e_bike rows instead of inventing a value.`,
	},
	{
		id: "ee_produktion_extern",
		label: "Erneuerbare Stromproduktion außerhalb des Stadtgebiets",
		collection: "power_production_external",
		periodField: "period",
		periodKind: "year_string",
		categories: ["pv", "wind"],
		unit: "kWh",
		fixedFields: (t) => ({ region: t.id, country: t.country }),
		updateField: { name: "update", type: "date" },
		guidance: `Annual electricity produced by plants owned by the city/Stadtwerke but located outside the city, in kWh.
- Convert MWh/GWh to kWh. Solar/Photovoltaik -> pv, Wind -> wind.`,
	},
];

export function getDataset(id: string): Dataset | undefined {
	return DATASETS.find((d) => d.id === id);
}

/** Normalise a period string from Claude into the DB representation, or null if invalid. */
export function normalisePeriod(d: Dataset, raw: string): string | number | null {
	const s = String(raw).trim();
	if (d.periodKind === "year" || d.periodKind === "year_string") {
		const m = s.match(/^(19|20)\d{2}$/);
		if (!m) return null;
		return d.periodKind === "year" ? Number(s) : s;
	}
	// month_end: accept YYYY-MM or YYYY-MM-DD, always store the last day of the month
	const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	if (month < 1 || month > 12) return null;
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`;
}
