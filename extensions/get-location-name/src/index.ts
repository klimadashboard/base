import type { Router, Request, Response } from "express";
import type { EndpointExtensionContext } from "@directus/extensions";
import fetch from "node-fetch";

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "your-fallback-token"; // Store this in .env

// Helper: round to 3 decimals (approx 100m)
const roundCoord = (value: number) => Math.round(value * 1000) / 1000;

export default {
	id: "get-location-name",
	handler: (
		router: Router,
		{ services, database, getSchema }: EndpointExtensionContext
	) => {
		const { ItemsService } = services;

		router.get("/", async (req: Request, res: Response) => {
			const latRaw = parseFloat(req.query.lat as string);
			const lonRaw = parseFloat(req.query.lon as string);
			const language = (req.query.lang as string) || "de";

			if (isNaN(latRaw) || isNaN(lonRaw)) {
				return res
					.status(400)
					.json({ error: "Invalid or missing lat/lon parameters" });
			}

			const lat = roundCoord(latRaw);
			const lon = roundCoord(lonRaw);

			try {
				const schema = await getSchema();
				const cacheService = new ItemsService("geocoding_cache", {
					schema,
					database,
				});

				// Check cache
				const existing = await cacheService.readByQuery({
					filter: {
						lat: { _eq: lat },
						lon: { _eq: lon },
					},
					limit: 1,
				});

				if (existing?.length > 0) {
					return res.json({ name: existing[0].location_name, cached: true });
				}

				// Fetch from Mapbox
				const mapboxRes = await fetch(
					`https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${MAPBOX_TOKEN}&language=${language}`
				);

				if (!mapboxRes.ok) {
					throw new Error(`Mapbox API error: ${mapboxRes.statusText}`);
				}

				const data = await mapboxRes.json();

				const locationName =
					data.features
						.filter(
							(f: any) =>
								f.place_type?.includes("place") ||
								f.place_type?.includes("region")
						)
						.map((f: any) => f.text)
						.join(", ") || "Unbekannt";

				// Save to cache
				await cacheService.createOne({ lat, lon, location_name: locationName });

				return res.json({ name: locationName, cached: false });
			} catch (err: any) {
				console.error("Geocoding error:", err);
				return res.status(500).json({
					error: "Failed to fetch location name",
					details: err.message,
				});
			}
		});
	},
};
