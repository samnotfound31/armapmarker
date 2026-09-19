import { z } from "zod";
import type { Destination, GeoPoint } from "../domain/types";
import type { DestinationSearchAdapter } from "../components/SearchScreen";

const destinationSchema = z
  .object({
    placeId: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(300),
    formattedAddress: z.string().trim().min(1).max(600),
    location: z
      .object({
        lat: z.number().finite().min(-90).max(90),
        lng: z.number().finite().min(-180).max(180)
      })
      .strict()
  })
  .strict();
const searchResponseSchema = z
  .object({ suggestions: z.array(destinationSchema) })
  .strict();

type SearchSuggestions = (
  query: string,
  origin: GeoPoint | undefined,
  signal: AbortSignal
) => Promise<Destination[]>;

export async function requestOrsDestinationSuggestions(
  query: string,
  origin: GeoPoint | undefined,
  signal: AbortSignal,
  fetchSearch: typeof fetch = fetch
): Promise<Destination[]> {
  const response = await fetchSearch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      ...(origin ? { origin: { lat: origin.lat, lng: origin.lng } } : {})
    }),
    signal
  });
  if (!response.ok) {
    const fallback = "Destination search could not be completed.";
    throw new Error(await safeErrorMessage(response, fallback));
  }
  const parsed = searchResponseSchema.safeParse(await safeJson(response));
  if (!parsed.success) {
    throw new Error("Destination search returned invalid results.");
  }
  return parsed.data.suggestions;
}

export function createOrsDestinationSearchAdapter(
  search: SearchSuggestions = requestOrsDestinationSuggestions
): DestinationSearchAdapter {
  return {
    mount(host, callbacks) {
      const container = document.createElement("div");
      container.className = "destination-search";
      const input = document.createElement("input");
      input.id = "destination-fallback";
      input.name = "destination";
      input.type = "search";
      input.autocomplete = "off";
      input.inputMode = "search";
      input.placeholder = "Search a place";
      input.setAttribute("aria-label", "Destination");
      const results = document.createElement("div");
      results.className = "destination-results";
      const status = document.createElement("p");
      status.className = "destination-search-status";
      status.setAttribute("aria-live", "polite");
      container.append(input, results, status);
      host.replaceChildren(container);

      let timer: ReturnType<typeof setTimeout> | undefined;
      let activeRequest: AbortController | undefined;
      let generation = 0;
      let disposed = false;

      const renderResults = (suggestions: readonly Destination[]) => {
        results.replaceChildren();
        for (const suggestion of suggestions) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "destination-result";
          const name = document.createElement("strong");
          name.textContent = suggestion.name;
          const address = document.createElement("span");
          address.textContent = suggestion.formattedAddress;
          button.append(name, address);
          button.addEventListener("click", () => callbacks.onSelect(suggestion));
          results.append(button);
        }
        status.textContent =
          suggestions.length === 0 ? "No destinations found." : "";
      };

      const runSearch = async (query: string, requestGeneration: number) => {
        activeRequest?.abort();
        const controller = new AbortController();
        activeRequest = controller;
        status.textContent = "Searching…";
        try {
          const suggestions = await search(
            query,
            callbacks.getOrigin?.() ?? callbacks.origin,
            controller.signal
          );
          if (!disposed && requestGeneration === generation) {
            renderResults(suggestions);
          }
        } catch (error) {
          if (controller.signal.aborted || disposed || requestGeneration !== generation) {
            return;
          }
          results.replaceChildren();
          status.textContent = "";
          callbacks.onError(
            error instanceof Error
              ? error.message
              : "Destination search could not be completed."
          );
        }
      };

      const onInput = () => {
        generation += 1;
        const requestGeneration = generation;
        if (timer) clearTimeout(timer);
        activeRequest?.abort();
        const query = input.value.trim();
        if (query.length < 2) {
          results.replaceChildren();
          status.textContent = "";
          return;
        }
        timer = setTimeout(() => {
          void runSearch(query, requestGeneration);
        }, 300);
      };

      input.addEventListener("input", onInput);
      return () => {
        disposed = true;
        generation += 1;
        if (timer) clearTimeout(timer);
        activeRequest?.abort();
        input.removeEventListener("input", onInput);
        container.remove();
      };
    }
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function safeErrorMessage(
  response: Response,
  fallback: string
): Promise<string> {
  const body = await safeJson(response);
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return fallback;
}
