# 🌍 Klimadashboard Base Extensions

This repository contains custom extensions for our [Directus](https://directus.io)-based database, providing additional functionality and custom API endpoints tailored for Klimadashboard.

---

## 🛠️ Getting Started: Building Extensions

To create a new custom extension, follow these steps:

1. **Recommended Resources**  
   While the [official Directus extension docs](https://docs.directus.io/extensions/endpoints.html) are useful, we especially recommend this more practical guide:  
   👉 [Proxy an external API in a custom endpoint extension](https://directus.io/docs/tutorials/extensions/proxy-an-external-api-in-a-custom-endpoint-extension)

2. **Generate a New Extension**  
   Inside the `extensions/` folder, run:

   ```bash
   npx create-directus-extension@latest
   ```

   Then follow the interactive setup to define your extension.

3. **Choose Your Language**  
   You can write your extension in either JavaScript (`index.js`) or TypeScript (`index.ts`) — choose whichever you're more comfortable with.

4. **Set a Unique Endpoint ID**  
   In your `src/index.js` or `src/index.ts` file, make sure to:
   - Define a unique `id` for your endpoint.
   - Use a clear, descriptive URI that reflects the purpose of the endpoint.

---

## 🚀 Deployment

Deployment is currently handled manually by David.

- **Important:** Each extension folder is automatically prefixed with `directus-extension-` during deployment. No need to add this manually.
- **Note:** Deployments require a **full Directus restart**, which makes continuous deployment currently impractical.
