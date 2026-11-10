import { Router, Request, Response } from "express";
import fetch from "node-fetch";

const typeDefs = [
	{
		key: "summerDay",
		descriptions: { de: "mindestens 25°C", en: "at least 25°C" },
		labels: { de: "Sommertage", en: "Summer Days" },
		color: "#DB7C37",
	},
	{
		key: "heatDay",
		descriptions: { de: "mindestens 30°C", en: "at least 30°C" },
		labels: { de: "Hitzetage", en: "Hot Days" },
		color: "#DB5537",
	},
	{
		key: "extremeHeatDay",
		descriptions: { de: "mindestens 35°C", en: "at least 35°C" },
		labels: { de: "Wüstentage", en: "Extreme Heat Days" },
		color: "#D61C1C",
	},
	{
		key: "tropicalNight",
		descriptions: { de: "nicht kühler als 20°C", en: "no cooler than 20°C" },
		labels: { de: "Tropennächte", en: "Tropical Nights" },
		color: "#B33965",
	},
	{
		key: "frostDay",
		descriptions: { de: "zwischenzeitlich unter 0°C", en: "temporarily below 0°C" },
		labels: { de: "Frosttage", en: "Frost Days" },
		color: "#39A4B3",
	},
	{
		key: "snowCoverDay",
		descriptions: { de: "mindestens 1cm Schnee", en: "at least 1cm snow" },
		labels: { de: "Schneetage", en: "Snow Cover Days" },
		color: "#6a9fcd",
	},
	{
		key: "iceDay",
		descriptions: { de: "nie über 0°C", en: "never above 0°C" },
		labels: { de: "Eistage", en: "Ice Days" },
		color: "#004989",
	},
];

// Translation helper
const t = (lang: "de" | "en", de: string, en: string) => (lang === "en" ? en : de);

// Helper to get stats source name
const getStatsSource = (country: string) =>
	country === "DE" ? "Destatis" : country === "AT" ? "Statistik Austria" : "";

// Panel builder for electric cars share
const buildElectricCarsPanel = (
	lang: "de" | "en",
	electricCars: number,
	totalCars: number,
	period: string,
	source: string
) => ({
	title: t(lang, "Elektroautos", "Electric Cars"),
	subtitle: t(
		lang,
		`Anteil Elektroautos an allen Autos (${period})`,
		`Share of all registered cars (${period})`
	),
	colorBackground: "#0074D9",
	colorText: "#fff",
	mostRecentOccurrence: 4,
	number: ((electricCars / totalCars) * 100).toFixed(1),
	unit: "%",
	source,
	list: [
		{ text: t(lang, `${electricCars.toLocaleString()} Elektroautos`, `${electricCars.toLocaleString()} electric cars`) },
		{ text: t(lang, `${totalCars.toLocaleString()} Autos insgesamt`, `${totalCars.toLocaleString()} total cars`) },
	],
});

// Panel builder for car density
const buildCarDensityPanel = (
	lang: "de" | "en",
	totalCars: number,
	population: number,
	period: string,
	source: string,
	regionInfo?: { name: string; layerLabel: string }
) => ({
	title: t(lang, "Autos je 1.000 Einwohner:innen", "Cars per 1,000 inhabitants"),
	subtitle: regionInfo
		? t(
				lang,
				`Autos pro 1.000 Einwohner:innen im Jahr ${period} in ${regionInfo.name} (${regionInfo.layerLabel})`,
				`Car ownership density (${period}) in ${regionInfo.name} (${regionInfo.layerLabel})`
		  )
		: t(lang, `Autos pro 1.000 Einwohner:innen (${period})`, `Car ownership density (${period})`),
	colorBackground: "#888",
	colorText: "#fff",
	mostRecentOccurrence: 4,
	number: ((totalCars / population) * 1000).toFixed(0),
	unit: t(lang, "Autos", "cars"),
	source,
	list: [
		{
			text: t(
				lang,
				`${totalCars.toLocaleString()} Autos bei ${population.toLocaleString()} Einwohner:innen`,
				`${totalCars.toLocaleString()} cars for ${population.toLocaleString()} inhabitants`
			),
		},
	],
});

export default {
	id: "get-region-summary",
	handler: (router: Router, { services }) => {
		const { ItemsService } = services;

		router.get("/", async (req: Request, res: Response) => {
			const regionId = req.query.region as string;
			const lang =
				(req.query.lang as string)?.toLowerCase() === "en" ? "en" : "de";
			const debug: string[] = [];

			if (!regionId)
				return res.status(400).json({ error: "Missing region parameter" });

			try {
				const regionService = new ItemsService("regions", {
					schema: req.schema,
					accountability: req.accountability,
					database: req.database,
				});

				// 🔧 include "layer" so we can decide if we must aggregate
				const region = await regionService.readOne(regionId, {
					fields: [
						"id",
						"name",
						"center",
						"attributes",
						"population",
						"area",
						"code_short",
						"code",
						"parents",
						"country",
						"layer",
						"layer_label",
					],
				});

				if (!region?.center || region.center.length !== 2) {
					return res
						.status(404)
						.json({ error: "Invalid region or missing center" });
				}

				const [lon, lat] = region.center;
				const baseUrl = `${req.protocol}://${req.get("host")}`;
				const panels: any[] = [];

				// Completely replaces previous getMunicipalityCodesUnderRegion
				async function getMunicipalityCodesUnderRegion(baseRegion: any) {
					// If already a municipality, return itself
					if (baseRegion.layer === "municipality") {
						return {
							muniCodesShort: [baseRegion.code_short].filter(Boolean),
							muniCodesLong: [baseRegion.code].filter(Boolean),
							totalMuniPopulation: baseRegion.population ?? null,
						};
					}

					const FIELDS = [
						"id",
						"name",
						"code_short",
						"code",
						"population",
						"parents",
						"country",
					] as const;
					let muniRows: any[] = [];

					// 1) Fast path for DE via AGS prefix (no JSON operators)
					if (baseRegion.country === "DE" && baseRegion.code_short) {
						const prefix =
							baseRegion.layer === "district"
								? String(baseRegion.code_short).slice(0, 5) // Kreis (5)
								: baseRegion.layer === "state"
								? String(baseRegion.code_short).slice(0, 2) // Land (2)
								: null;

						if (prefix) {
							const rows = await regionService.readByQuery({
								filter: {
									layer: { _eq: "municipality" },
									code_short: { _starts_with: prefix },
								},
								limit: -1,
								fields: FIELDS as any,
							});
							if (rows?.length) {
								muniRows = rows;
								debug.push(
									`DE prefix match: found ${rows.length} municipalities for prefix ${prefix} (${baseRegion.name})`
								);
							}
						}
					}

					// 2) Fallback: wide pull (chunked) + JS filter on parents (works on all DBs)
					if (muniRows.length === 0) {
						// Pull all municipalities in chunks to avoid large responses
						const CHUNK = 1000;
						let page = 0;
						let done = false;
						const all: any[] = [];

						while (!done) {
							const rows = await regionService.readByQuery({
								filter: { layer: { _eq: "municipality" } },
								// Directus pagination: use offset; if you use "page"/"limit" instead, adjust here
								offset: page * CHUNK,
								limit: CHUNK,
								fields: FIELDS as any,
							});

							const batch = rows || [];
							all.push(...batch);
							if (batch.length < CHUNK) done = true;
							page++;
						}

						const idStr = String(baseRegion.id);
						muniRows = all.filter(
							(r: any) =>
								Array.isArray(r.parents) &&
								r.parents.some((p: any) => String(p?.id) === idStr)
						);

						debug.push(
							`Wide scan fallback: scanned ${all.length} municipalities, matched ${muniRows.length} via parents.id=${idStr}`
						);
					}

					const muniCodesShort = muniRows
						.map((r: any) => r.code_short)
						.filter(Boolean);
					const muniCodesLong = muniRows
						.map((r: any) => r.code)
						.filter(Boolean);
					const totalMuniPopulation =
						muniRows.reduce(
							(a: number, r: any) => a + (r.population || 0),
							0
						) || null;

					debug.push(
						`Municipalities under ${baseRegion.name}: ${
							muniRows.length
						} (ex: ${muniCodesShort.slice(0, 5).join(", ")})`
					);

					return { muniCodesShort, muniCodesLong, totalMuniPopulation };
				}

				// === Weather indicators (unchanged) ===
				const stationRes = await fetch(
					`${baseUrl}/get-nearest-stations?lat=${lat}&lon=${lon}&limit=1`
				);
				if (!stationRes.ok) throw new Error("Failed to fetch station");
				const stations = await stationRes.json();
				const station = stations[0];
				if (!station)
					return res.status(404).json({ error: "No station found" });

				const table =
					station.source === "de_dwd_stations"
						? "de_dwd_data"
						: "at_geosphere_data";
				const indicatorsRes = await fetch(
					`${baseUrl}/get-weather-indicators-for-station?station=${station.id}&table=${table}`
				);
				if (!indicatorsRes.ok) throw new Error("Failed to fetch indicators");
				const indicators = await indicatorsRes.json();

				Object.entries(indicators as Record<string, any>).forEach(([rawKey, value]) => {
					const key = rawKey.trim();
					const typeDef = typeDefs.find((td) => td.key === key);
					if (!typeDef) debug.push(`Unknown indicator key: ${key}`);

					// Skip panels where all values are 0 (no meaningful data)
					const lastYear = value.lastYear ?? 0;
					const thisYear = value.thisYear ?? 0;
					const historicAvg = value.historicAverage1961to1990 ?? 0;
					if (lastYear === 0 && thisYear === 0 && historicAvg === 0) {
						debug.push(`Skipping ${key}: all values are 0`);
						return;
					}

					const description = typeDef?.descriptions?.[lang] ?? key;
					panels.push({
						title: typeDef?.labels?.[lang] ?? key,
						subtitle: `${description} ${t(lang, "im letzten Jahr", "last year")}`,
						colorBackground: typeDef?.color ?? "#888",
						colorText: "#fff",
						number: lastYear,
						unit: t(lang, "Tage", "days"),
						source:
							station.name +
							(station.distance_km > 6
								? ` | ${Math.round(station.distance_km)}km ${t(lang, "entfernt", "away")}`
								: ""),
						mostRecentOccurrence: value.mostRecentOccurrence,
						list: [
							{
								text: t(
									lang,
									`${historicAvg} im Durchschnitt 1961–1990`,
									`${historicAvg} on average (1961–1990)`
								),
							},
							{
								text: t(
									lang,
									`${thisYear} bisher in ${new Date().getFullYear()}`,
									`${thisYear} so far in ${new Date().getFullYear()}`
								),
							},
						],
					});
				});

				// === Balkonkraftwerke (DE only) — aggregate directly from energy_solar_units ===
				if (region.country === "DE") {
					try {
						const { ItemsService } = services;
						const solarService = new ItemsService("energy_solar_units", {
							schema: req.schema,
							database: req.database,
							accountability: req.accountability,
						});

						// Build the list of region keys to filter by
						const { muniCodesShort, muniCodesLong } =
							await getMunicipalityCodesUnderRegion(region);

						// If we’re at municipality level, include the exact codes for the region as well
						const selfShort =
							region.layer === "municipality" && region.code_short
								? [region.code_short]
								: [];
						const selfLong =
							region.layer === "municipality" && region.code
								? [region.code]
								: [];

						// Combined list — we try both columns because we don't know which key was stored in energy_solar_units.region
						const regionKeys = Array.from(
							new Set(
								[
									...selfShort,
									...selfLong,
									...muniCodesShort,
									...muniCodesLong,
								].filter(Boolean)
							)
						);

						debug.push(
							`Balkonkraftwerke aggregation regionKeys: ${regionKeys.length}`
						);

						// If for some reason we have no keys, skip gracefully
						if (regionKeys.length > 0) {
							// Pull all rows for type=2961 (balcony), active commissioning_date
							const rows = await solarService.readByQuery({
								fields: [
									"region",
									"commissioning_date",
									"shutdown_date",
									"power_kw",
								],
								filter: {
									type: { _eq: 2961 },
									commissioning_date: { _nnull: true },
									region: { _in: regionKeys },
								},
								limit: -1,
							});

							debug.push(
								`Fetched ${rows.length} solar rows for Balkonkraftwerke aggregation`
							);

							// Reproduce the same year-by-year logic your /get-balkonkraftwerke uses
							const now = new Date();
							const currentYear = now.getFullYear();
							const yearRange = Array.from(
								{ length: currentYear - 2000 + 1 },
								(_, i) => 2000 + i
							);

							const statsPerYear: Record<
								number,
								{ added_units: number; added_kw: number }
							> = {};
							for (const y of yearRange)
								statsPerYear[y] = { added_units: 0, added_kw: 0 };

							for (const row of rows) {
								const commissioningDate = new Date(row.commissioning_date);
								const commissioningYear = commissioningDate.getFullYear();
								if (commissioningYear < 2000 || commissioningDate > now)
									continue;

								const shutdownDate = row.shutdown_date
									? new Date(row.shutdown_date)
									: null;
								const isStillActive = !shutdownDate || shutdownDate > now;

								if (isStillActive) {
									statsPerYear[commissioningYear].added_units += 1;
									statsPerYear[commissioningYear].added_kw += row.power_kw ?? 0;
								}
							}

							const result = [];
							let cumulative_units = 0;
							let cumulative_kw = 0;
							for (const y of yearRange) {
								const { added_units, added_kw } = statsPerYear[y];
								cumulative_units += added_units;
								cumulative_kw += added_kw;
								result.push({
									year: y,
									added_units,
									added_kw: Math.round(added_kw * 100) / 100,
									cumulative_units,
									cumulative_kw: Math.round(cumulative_kw * 100) / 100,
								});
							}

							const latest = result[result.length - 1];
							const thisYear = result.find((r) => r.year === currentYear);
							const lastYear = result.find((r) => r.year === currentYear - 1);

							// Only push a panel if we have any units at all (or keep panel with 0 if you prefer)
							if (latest) {
								const dateStr = new Date(Date.now() - 86400000).toLocaleDateString(lang === "en" ? "en-US" : "de-DE");
								panels.push({
									title: t(lang, "Balkonkraftwerke", "Balcony Solar Systems"),
									subtitle: t(
										lang,
										`sind derzeit in ${region.name} (${region.layer_label}) installiert`,
										`currently installed in ${region.name} (${region.layer_label})`
									),
									colorBackground: "#055A5B",
									colorText: "#E6E6E6",
									mostRecentOccurrence: 2,
									number: latest.cumulative_units,
									unit: t(lang, "Balkonkraftwerke", "units"),
									source: t(
										lang,
										`Marktstammdatenregister der Bundesnetzagentur | Datenstand: ${dateStr}`,
										`German Federal Network Agency | Data as of: ${dateStr}`
									),
									list: [
										{
											text: t(
												lang,
												`Seit Jahresbeginn installiert: ${thisYear?.added_units ?? 0}`,
												`Since start of year: ${thisYear?.added_units ?? 0}`
											),
										},
										{
											text: t(
												lang,
												`${currentYear - 1} installiert: ${lastYear?.added_units ?? 0} Balkonkraftwerke`,
												`${currentYear - 1} installed: ${lastYear?.added_units ?? 0} units`
											),
										},
									],
								});
							} else {
								debug.push("No yearly result computed for Balkonkraftwerke.");
							}
						} else {
							debug.push(
								"No municipality keys available for Balkonkraftwerke aggregation."
							);
						}
					} catch (err: any) {
						debug.push(
							`Failed to aggregate Balkonkraftwerke directly: ${err.message}`
						);
					}
				}

				// === Cars ===
				async function findCarDataRegion(
					baseRegion: any,
					parentRegions: any[],
					carsService: any,
					debug: string[],
					requireElectric = false
				) {
					const tryRegions = [baseRegion, ...parentRegions];

					for (const reg of tryRegions) {
						const codesToTry = [reg.code_short, reg.code].filter(Boolean);

						for (const code of codesToTry) {
							debug.push(`Checking car data for code: ${code}`);
							const result = await carsService.readByQuery({
								filter: {
									region: { _eq: code },
									category: { _in: ["Elektro", "Gesamt", "Insgesamt"] },
								},
								limit: -1,
								fields: ["category", "value", "region", "period"],
							});
							debug.push(` - Found ${result.length} records for code: ${code}`);

							if (result.length === 0) continue;

							const periods = Array.from(
								new Set(result.map((d: any) => d.period))
							).sort((a: any, b: any) => parseInt(b) - parseInt(a));

							for (const period of periods) {
								const entries = result.filter((d: any) => d.period === period);
								const hasTotal = entries.some((e: any) =>
									["gesamt", "insgesamt"].includes(
										String(e.category || "").toLowerCase()
									)
								);
								const hasElectric = entries.some(
									(e: any) =>
										String(e.category || "").toLowerCase() === "elektro"
								);

								debug.push(
									` - Checking ${entries.length} entries for period ${period} → hasTotal: ${hasTotal}, hasElectric: ${hasElectric}`
								);

								if (hasTotal && (!requireElectric || hasElectric)) {
									debug.push(
										` - Using region for ${
											requireElectric ? "electric share" : "density"
										}: ${reg.code || reg.code_short || reg.name}`
									);
									return {
										carRegion: reg,
										carData: entries,
										selectedPeriod: period,
										hasElectric,
									};
								}
							}
						}
					}

					debug.push(
						`❌ No matching car data found for ${
							requireElectric ? "electric share" : "density"
						}`
					);
					return null;
				}

				// 🔧 NEW: aggregate cars from municipalities if nothing found for district/state
				async function aggregateCarsFromMunicipalities(
					baseRegion: any,
					carsService: any
				): Promise<null | {
					selectedPeriod: string;
					totalCars: number;
					electricCars: number | null; // null if not available
				}> {
					if (
						!(baseRegion.layer === "district" || baseRegion.layer === "state")
					)
						return null;

					const { muniCodesShort, muniCodesLong } = await getMunicipalityCodesUnderRegion(
						baseRegion
					);
					const muniCodes = [...new Set([...muniCodesShort, ...muniCodesLong])];
					if (muniCodes.length === 0) return null;

					// Pull all muni rows in one go
					const rows = await carsService.readByQuery({
						filter: {
							region: { _in: muniCodes },
							category: { _in: ["Elektro", "Gesamt", "Insgesamt"] },
						},
						limit: -1,
						fields: ["category", "value", "period"],
					});

					if (!rows || rows.length === 0) return null;

					// Group by period → sum by category
					const byPeriod = new Map<
						string,
						{ total: number; electric: number | null }
					>();

					for (const r of rows) {
						const p = String(r.period);
						const cat = String(r.category || "").toLowerCase();
						const val = Number(r.value) || 0;
						const cur = byPeriod.get(p) || { total: 0, electric: 0 };
						if (cat === "elektro") {
							cur.electric = (cur.electric ?? 0) + val;
						} else if (cat === "gesamt" || cat === "insgesamt") {
							cur.total += val;
						}
						byPeriod.set(p, cur);
					}

					// Choose latest period that has total; electric may be missing → then electricCars is null
					const periods = Array.from(byPeriod.keys()).sort(
						(a, b) => parseInt(b) - parseInt(a)
					);
					for (const p of periods) {
						const cur = byPeriod.get(p)!;
						if (cur.total > 0) {
							return {
								selectedPeriod: p,
								totalCars: cur.total,
								electricCars: cur.electric ?? null,
							};
						}
					}
					return null;
				}

				try {
					const carsService = new ItemsService("mobility_cars", {
						schema: req.schema,
						accountability: req.accountability,
						database: req.database,
					});

					const parentIds = region.parents?.map((p: any) => p.id) || [];
					let parentRegions: any[] = [];

					if (parentIds.length > 0) {
						parentRegions = await regionService.readByQuery({
							filter: { id: { _in: parentIds } },
							fields: [
								"id",
								"code",
								"code_short",
								"name",
								"country",
								"layer_label",
								"layer",
								"parents",
								"population",
							],
							limit: -1,
						});
					}

					// 1) Electric share (prefer direct/parent; fallback to aggregated municipalities)
					let electricPanelDone = false;
					{
						const electricResult = await findCarDataRegion(
							region,
							parentRegions,
							carsService,
							debug,
							true
						);

						if (electricResult) {
							const { carRegion, carData, selectedPeriod } = electricResult;
							const totalCars =
								carData.find((c: any) => ["Gesamt", "Insgesamt"].includes(c.category))?.value ?? 0;
							const electricCars =
								carData.find((c: any) => c.category === "Elektro")?.value ?? 0;

							if (totalCars > 0) {
								const source = `${getStatsSource(carRegion.country as string)} (${carRegion.layer_label} ${carRegion.name})`;
								panels.push(buildElectricCarsPanel(lang, electricCars, totalCars, String(selectedPeriod), source));
								electricPanelDone = true;
							}
						} else {
							// 🔧 Fallback aggregate
							const agg = await aggregateCarsFromMunicipalities(region, carsService);
							if (agg && agg.totalCars > 0 && agg.electricCars !== null) {
								const source = t(
									lang,
									`${getStatsSource(region.country as string)} (aggregiert aus Gemeinden)`,
									`${getStatsSource(region.country as string)} (aggregated from municipalities)`
								);
								panels.push(buildElectricCarsPanel(lang, agg.electricCars, agg.totalCars, agg.selectedPeriod, source));
								electricPanelDone = true;
							}
						}
					}

					// 2) Car density (prefer direct/parent; fallback to aggregated municipalities)
					{
						const densityResult = await findCarDataRegion(region, parentRegions, carsService, debug, false);
						if (densityResult) {
							const { carRegion, carData, selectedPeriod } = densityResult;
							const totalCars =
								carData.find((c: any) => ["Gesamt", "Insgesamt"].includes(c.category))?.value ?? 0;
							const population = region.population ?? carRegion.population ?? 0;

							if (population > 0 && totalCars > 0) {
								const source = `${getStatsSource(carRegion.country as string)}${region.population ? t(lang, " (Regionpopulation)", " (region population)") : ""}`;
								panels.push(buildCarDensityPanel(
									lang, totalCars, population, String(selectedPeriod), source,
									{ name: carRegion.name as string, layerLabel: carRegion.layer_label as string }
								));
							}
						} else {
							// 🔧 Fallback aggregate (total only)
							const agg = await aggregateCarsFromMunicipalities(region, carsService);
							if (agg && agg.totalCars > 0) {
								// If district/state pop is missing, try sum of municipal populations
								let popForDensity = region.population ?? null;
								if (!popForDensity) {
									const { totalMuniPopulation } = await getMunicipalityCodesUnderRegion(region);
									popForDensity = totalMuniPopulation;
								}

								if (popForDensity && popForDensity > 0) {
									const source = t(
										lang,
										`${getStatsSource(region.country as string)} (aggregiert aus Gemeinden)`,
										`${getStatsSource(region.country as string)} (aggregated from municipalities)`
									);
									panels.push(buildCarDensityPanel(lang, agg.totalCars, popForDensity, agg.selectedPeriod, source));
								} else {
									debug.push(
										"No population found for density calculation after aggregation."
									);
								}
							}
						}
					}
				} catch (err: any) {
					debug.push(`Failed to fetch car data: ${err.message}`);
				}

				res.json({
					panels: panels.sort(
						(a, b) =>
							(a.mostRecentOccurrence ?? Infinity) -
							(b.mostRecentOccurrence ?? Infinity)
					),
					debug,
				});
			} catch (err: any) {
				console.error("Error in /get-region-summary:", err);
				res.status(500).json({ error: "Internal error", detail: err.message });
			}
		});
	},
};
