import type { Router, Request, Response } from "express";
import type { EndpointExtensionContext } from "@directus/extensions";

export default {
	id: "get-search-results",
	handler: (
		router: Router,
		{ services, database, getSchema }: EndpointExtensionContext,
	) => {
		const { ItemsService } = services;

		router.get("/", async (req: Request, res: Response) => {
			const query = (req.query.q as string)?.trim().toLowerCase();
			const country = req.query.country
				? (req.query.country as string).toUpperCase()
				: undefined;
			const language = ((req.query.lang as string) || "de").toLowerCase();
			const site = ((req.query.site as string) || "default").toLowerCase();
			const rawLimit = parseInt(req.query.limit as string);
			const limit = Math.min(isNaN(rawLimit) ? 100 : rawLimit, 100);

			const allowedTables = ["regions", "charts", "pages", "companies"];
			const requestedTables = ((req.query.tables as string) || "")
				.split(",")
				.map((t) => t.trim())
				.filter((t) => allowedTables.includes(t));
			const tablesToQuery =
				requestedTables.length > 0 ? requestedTables : allowedTables;

			if (!query || query.length < 1) {
				return res
					.status(400)
					.json({ error: "Missing or empty 'q' parameter" });
			}

			try {
				const schema = await getSchema();

				const regionsService = new ItemsService("regions", {
					database,
					schema,
				});
				const chartsService = new ItemsService("charts", { database, schema });
				const pagesService = new ItemsService("pages", { database, schema });
				const companiesService = new ItemsService("companies", {
					database,
					schema,
				});

				let regionMappedExact: any[] = [];
				let regionMappedPartial: any[] = [];
				let chartMappedExact: any[] = [];
				let chartMappedPartial: any[] = [];
				let pageMappedExact: any[] = [];
				let pageMappedPartial: any[] = [];
				let companyMappedExact: any[] = [];
				let companyMappedPartial: any[] = [];

				if (tablesToQuery.includes("regions")) {
					const regionFilterBase: any[] = [
						{ visible: { _eq: true } },
						{ layer: { _in: ["municipality", "district"] } },
					];
					if (country) regionFilterBase.push({ country: { _eq: country } });

					const allRegions = await regionsService.readByQuery({
						filter: regionFilterBase.length
							? { _and: regionFilterBase }
							: undefined,
						fields: [
							"id",
							"name",
							"postcodes",
							"country",
							"layer",
							"layer_label",
							"population",
							"parents",
						],
						limit: -1,
					});

					// municipalities disambiguate via their district (Kreis), districts via their state
					const parentLayerFor: Record<string, string> = {
						municipality: "district",
						district: "state",
					};

					const parentIdsNeeded = new Set<string>();
					for (const r of allRegions) {
						const wantedLayer = parentLayerFor[r.layer];
						if (!wantedLayer || !Array.isArray(r.parents)) continue;
						const parent = r.parents.find((p: any) => p?.layer === wantedLayer);
						if (parent?.id) parentIdsNeeded.add(parent.id);
					}

					const parentLabelById = new Map<string, string>();
					if (parentIdsNeeded.size > 0) {
						const parentRegions = await regionsService.readByQuery({
							filter: { id: { _in: Array.from(parentIdsNeeded) } },
							fields: ["id", "name", "layer_label"],
							limit: -1,
						});
						for (const p of parentRegions) {
							parentLabelById.set(
								p.id,
								[p.layer_label, p.name].filter(Boolean).join(" "),
							);
						}
					}

					const mapRegions = (items: any[], matchType: "exact" | "partial") =>
						items.map((r) => {
							let matchedPostcode = "";
							if (Array.isArray(r.postcodes)) {
								matchedPostcode =
									r.postcodes.find((p) =>
										matchType === "exact"
											? p.toLowerCase() === query
											: p.toLowerCase().includes(query),
									) || r.postcodes[0];
							}

							const wantedLayer = parentLayerFor[r.layer];
							const parent =
								wantedLayer && Array.isArray(r.parents)
									? r.parents.find((p: any) => p?.layer === wantedLayer)
									: undefined;
							const parentLabel = parent && parentLabelById.get(parent.id);

							return {
								id: r.id,
								title: r.name,
								subtitle: parentLabel || matchedPostcode || "",
								source: r.layer,
								sourceLabel: r.layer_label || "",
								country: r.country,
								layer: r.layer,
								matchType,
								score: matchType === "exact" ? 100 : 50,
								population: r.population ?? 0,
							};
						});

					const lowerQuery = query.toLowerCase();

					const regionExact = allRegions.filter(
						(r) =>
							r.name?.toLowerCase() === lowerQuery ||
							(Array.isArray(r.postcodes) &&
								r.postcodes.some((p) => p.toLowerCase() === lowerQuery)),
					);

					const regionPartial = allRegions.filter(
						(r) =>
							(r.name?.toLowerCase().includes(lowerQuery) ||
								(Array.isArray(r.postcodes) &&
									r.postcodes.some((p) =>
										p.toLowerCase().includes(lowerQuery),
									))) &&
							!(
								r.name?.toLowerCase() === lowerQuery ||
								(Array.isArray(r.postcodes) &&
									r.postcodes.some((p) => p.toLowerCase() === lowerQuery))
							),
					);

					regionPartial.sort(
						(a, b) => (b.population ?? 0) - (a.population ?? 0),
					);

					regionMappedExact = mapRegions(regionExact, "exact");
					regionMappedPartial = mapRegions(regionPartial, "partial");
				}

				if (tablesToQuery.includes("companies")) {
					const allCompanies = await companiesService.readByQuery({
						fields: ["id", "name"],
						limit: -1,
					});

					const exact = allCompanies.filter(
						(c) => c.name?.toLowerCase() === query,
					);
					const partial = allCompanies.filter(
						(c) =>
							c.name?.toLowerCase().includes(query) &&
							c.name?.toLowerCase() !== query,
					);

					companyMappedExact = exact.map((c) => ({
						id: c.id,
						title: c.name,
						subtitle: "",
						source: "company",
						matchType: "exact",
						score: 70,
					}));

					companyMappedPartial = partial.map((c) => ({
						id: c.id,
						title: c.name,
						subtitle: "",
						source: "company",
						matchType: "partial",
						score: 35,
					}));
				}

				if (tablesToQuery.includes("pages")) {
					const allPages = await pagesService.readByQuery({
						filter: { site: { _eq: site }, status: { _eq: "published" } },
						fields: ["id", "translations.title", "translations.slug"],
						deep: { translations: true },
						limit: -1,
					});

					const exact = allPages.filter(
						(p) => p.translations?.[0]?.title?.toLowerCase() === query,
					);
					const partial = allPages.filter(
						(p) =>
							p.translations?.[0]?.title?.toLowerCase().includes(query) &&
							p.translations?.[0]?.title?.toLowerCase() !== query,
					);

					pageMappedExact = exact.map((p) => ({
						id: p.id,
						title: p.translations?.[0]?.title || "",
						subtitle: "",
						slug: p.translations?.[0]?.slug || "",
						source: "page",
						matchType: "exact",
						score: 80,
					}));

					pageMappedPartial = partial.map((p) => ({
						id: p.id,
						title: p.translations?.[0]?.title || "",
						subtitle: "",
						slug: p.translations?.[0]?.slug || "",
						source: "page",
						matchType: "partial",
						score: 40,
					}));
				}

				if (tablesToQuery.includes("charts")) {
					const allCharts = await chartsService.readByQuery({
						filter: { site: { _eq: site }, status: { _eq: "published" } },
						fields: ["id", "translations.title"],
						deep: { translations: true },
						limit: -1,
					});

					const exact = allCharts.filter(
						(c) => c.translations?.[0]?.title?.toLowerCase() === query,
					);
					const partial = allCharts.filter(
						(c) =>
							c.translations?.[0]?.title?.toLowerCase().includes(query) &&
							c.translations?.[0]?.title?.toLowerCase() !== query,
					);

					chartMappedExact = exact.map((c) => ({
						id: c.id,
						title: c.translations?.[0]?.title || "",
						subtitle: "",
						source: "chart",
						matchType: "exact",
						score: 90,
					}));

					chartMappedPartial = partial.map((c) => ({
						id: c.id,
						title: c.translations?.[0]?.title || "",
						subtitle: "",
						source: "chart",
						matchType: "partial",
						score: 45,
					}));
				}

				const combinedResults = [
					...regionMappedExact,
					...pageMappedExact,
					...chartMappedExact,
					...companyMappedExact,
					...regionMappedPartial,
					...pageMappedPartial,
					...chartMappedPartial,
					...companyMappedPartial,
				];

				const sortedResults = combinedResults.sort((a, b) => {
					if (b.score !== a.score) return b.score - a.score;
					if ((b.population ?? 0) !== (a.population ?? 0))
						return (b.population ?? 0) - (a.population ?? 0);
					return a.title.localeCompare(b.title);
				});

				return res.json(sortedResults.slice(0, limit));
			} catch (err: any) {
				console.error(err);
				return res
					.status(500)
					.json({ error: "Internal Server Error", details: err.message });
			}
		});
	},
};
