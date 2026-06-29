import Dockerode from "dockerode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegistryLoginSchema, RegistrySearchSchema, RegistryPushSchema } from "../types.js";
import { formatError, withRetry } from "../docker.js";

export function registerRegistryTools(server: McpServer, docker: Dockerode): void {
  // registry_login — authenticate with a Docker registry
  server.tool(
    "registry_login",
    "Authenticate with a Docker registry (Docker Hub, ECR, ACR, GCR, or private). Stores credentials in Docker config for subsequent push/pull operations. Use registry_search to find images before pushing. Returns login confirmation with the registry server address.",
    RegistryLoginSchema.shape,
    { openWorldHint: true },
    async (params) => {
      try {
        const auth = {
          username: params.username,
          password: params.password,
          serveraddress: params.server || "https://index.docker.io/v1/",
        };
        const result = await withRetry(
          () => docker.checkAuth(auth),
          { label: "registry_login" }
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "logged_in",
              server: params.server || "https://index.docker.io/v1/",
              username: params.username,
              identity_token: result.IdentityToken || "none",
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  // registry_search — search Docker Hub for images
  server.tool(
    "registry_search",
    "Search Docker Hub for available images by keyword. Returns image names, short descriptions, star counts, and official/premium status. Useful for discovering base images or checking if an image exists before pulling.",
    RegistrySearchSchema.shape,
    { readOnlyHint: true, openWorldHint: true },
    async (params) => {
      try {
        const results = await withRetry(
          () => docker.searchImages(params.term),
          { label: "registry_search" }
        );
        const images = results.slice(0, 20).map((r: any) => ({
          name: r.Name,
          description: (r.Description || "").substring(0, 150),
          stars: r.StarCount || 0,
          official: r.IsOfficial || false,
          automated: r.IsAutomated || false,
        }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query: params.term,
              total_results: results.length,
              showing: images.length,
              images,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );

  // registry_push — push a local image to a registry
  server.tool(
    "registry_push",
    "Push a local Docker image to a registry. The image must be tagged with the registry address first (e.g., myregistry.com/myimage:tag). Use registry_login to authenticate before pushing. Use build_image to create the image, then tag it with docker CLI or the Docker API before pushing.",
    RegistryPushSchema.shape,
    { openWorldHint: true },
    async (params) => {
      try {
        const imageRef = params.tag
          ? `${params.image}:${params.tag}`
          : params.image;

        const image = docker.getImage(imageRef);
        const stream = await image.push();

        await new Promise<void>((resolve, reject) => {
          docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "pushed",
              image: imageRef,
              message: `Image ${imageRef} pushed to registry successfully.`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${formatError(error)}` }], isError: true };
      }
    }
  );
}
