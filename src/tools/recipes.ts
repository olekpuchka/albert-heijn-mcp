import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addProductsToShoppingList,
  ahPageUrl,
  getMealPlan,
  getRecipe,
  type Product,
  productUrl,
  type RecipeFilter,
  type RecipeSort,
  recipeUrl,
  searchRecipes,
} from "../ahapi/index.ts";
import { addAuthedTool, nonFatal, orDefault, parallel, structured, type ToolContext, wrapError } from "./common.ts";
import { search } from "./products.ts";
import { listCall } from "./shoppingList.ts";
import { productSummary, summarizeProduct } from "./views.ts";

/** Title of a planner entry AH sent without one. */
const UNTITLED = "(untitled; see the AH app)";

const num = z.number().optional();
const str = z.string().optional();
const strs = z.array(z.string()).optional();

/** Recipe search filters → AH filter group and value. */
const RECIPE_FILTERS = {
  // Labels
  easy: ["veel-gebruikt", "makkelijk"],
  quick: ["veel-gebruikt", "snel"],
  budget: ["veel-gebruikt", "budget"],
  healthy: ["veel-gebruikt", "gezond"],
  light: ["veel-gebruikt", "slank"],
  // Course
  main_course: ["menugang", "hoofdgerecht"],
  starter: ["menugang", "voorgerecht"],
  side_dish: ["menugang", "bijgerecht"],
  dessert: ["menugang", "nagerecht"],
  breakfast: ["menugang", "ontbijt"],
  brunch: ["menugang", "brunch"],
  lunch: ["menugang", "lunch"],
  snack: ["menugang", "tussendoortje"],
  appetizer: ["menugang", "borrelhapje"],
  baking: ["menugang", "gebak"],
  kids: ["menugang", "kindergerecht"],
  // Dish
  pasta: ["soort-gerecht", "pasta"],
  rice: ["soort-gerecht", "rijst"],
  salad: ["soort-gerecht", "salade"],
  soup: ["soort-gerecht", "soep"],
  stamppot: ["soort-gerecht", "stamppot"],
  quiche: ["soort-gerecht", "quiche"],
  wrap: ["soort-gerecht", "wrap"],
  sandwich: ["soort-gerecht", "brood-sandwiches"],
  // Main ingredient
  meat: ["recepten-met", "vlees"],
  poultry: ["recepten-met", "gevogelte"],
  fish: ["recepten-met", "vis"],
  shellfish: ["recepten-met", "schaal-schelpdieren"],
  meat_substitute: ["recepten-met", "vleesvervanger"],
  // Diet
  vegetarian: ["speciale-wensen", "vegetarisch"],
  vegan: ["speciale-wensen", "veganistisch"],
  no_meat: ["speciale-wensen", "zonder-vlees"],
  no_meat_or_fish: ["speciale-wensen", "zonder-vlees-vis"],
  gluten_free: ["speciale-wensen", "glutenvrij"],
  lactose_free: ["speciale-wensen", "lactosevrij"],
  high_protein: ["speciale-wensen", "eiwitrijk"],
  keto: ["speciale-wensen", "keto"],
  // Occasion
  christmas: ["momenten", "kerst"],
  easter: ["momenten", "pasen"],
  new_year: ["momenten", "oud-en-nieuw"],
  birthday: ["momenten", "verjaardag"],
  barbecue: ["momenten", "barbecue"],
  picnic: ["momenten", "picknick"],
  party: ["momenten", "borrel"],
  // Season
  spring: ["seizoen", "lente"],
  summer: ["seizoen", "zomer"],
  autumn: ["seizoen", "herfst"],
  winter: ["seizoen", "winter"],
  // Cooking method
  oven: ["kooktechniek", "oven"],
  airfryer: ["kooktechniek", "airfryer"],
  grill: ["kooktechniek", "grillen"],
  stir_fry: ["kooktechniek", "roerbakken-wokken"],
  stew: ["kooktechniek", "stoven"],
  steam: ["kooktechniek", "stomen"],
  // Cuisine
  italian: ["keuken", "italiaans"],
  dutch: ["keuken", "nederlands"],
  french: ["keuken", "frans"],
  spanish: ["keuken", "spaans"],
  greek: ["keuken", "grieks"],
  mediterranean: ["keuken", "mediterraan"],
  middle_eastern: ["keuken", "midden-oosters"],
  moroccan: ["keuken", "marokkaans"],
  turkish: ["keuken", "turks"],
  asian: ["keuken", "aziatisch"],
  chinese: ["keuken", "chinees"],
  japanese: ["keuken", "japans"],
  thai: ["keuken", "thais"],
  vietnamese: ["keuken", "vietnamees"],
  indian: ["keuken", "indiaas"],
  indonesian: ["keuken", "indonesisch"],
  surinamese: ["keuken", "surinaams"],
  mexican: ["keuken", "mexicaans"],
  american: ["keuken", "amerikaans"],
} as const satisfies Record<string, readonly [string, string]>;
type RecipeFilterName = keyof typeof RECIPE_FILTERS;

const RECIPE_SORTS = { relevance: "MOST_RELEVANT", newest: "NEWEST", popular: "POPULAR" } as const satisfies Record<
  string,
  RecipeSort
>;
type RecipeSortName = keyof typeof RECIPE_SORTS;

/** Filter names → AH filters, one per group. */
function recipeFilters(names: readonly RecipeFilterName[]): RecipeFilter[] {
  const groups = new Map<string, Set<string>>();
  for (const name of names) {
    const [group, value] = RECIPE_FILTERS[name];
    groups.set(group, (groups.get(group) ?? new Set()).add(value));
  }
  return [...groups].map(([group, values]) => ({ group, values: [...values] }));
}

/** Words that mark an ingredient nobody buys: "kokend water", "500 ml water", not "waterkers" or "kokoswater". */
const TAP_WATER = new Set(["water", "kraanwater", "ijswater"]);

/** Search results scored per ingredient: AH ranks flavoured products (apple yoghurt) above plain ones (apples). */
const CANDIDATES = 20;

/** Words that say nothing about what the product is: labels, packaging and filler. */
const NEUTRAL = new Set(
  ["ah", "biologisch", "biologische", "bio", "excellent", "basic", "terra", "vers", "verse", "stuk", "stuks", "per"].concat(
    ["uit", "in", "met", "van", "en", "of", "de", "het", "een"],
    ["blik", "pot", "potje", "pak", "zak", "fles", "schaal", "net", "doos", "doosje", "bak", "bakje", "tros"],
  ),
);

/** Product types that make a title a flavoured product ("knijpyoghurt appel", "crackers zout") unless the ingredient names them. */
const PRODUCT_TYPES = ["yoghurt", "kwark", "vla", "toetje", "sap", "drank", "limonade", "smoothie", "thee"].concat(
  ["crackers", "chips", "pretzels", "popcorn", "koek", "koekjes", "wafels", "reep", "snoep", "zoutjes", "ijs"],
);

/** Dutch adjective forms: "rode paprika" is AH's "Paprika rood". */
const BASE: Record<string, string> = { rode: "rood", gele: "geel", groene: "groen", witte: "wit", zwarte: "zwart", zoete: "zoet" };

/** Lowercase words without accents or neutral ones, e.g. for a search query. */
const plainWords = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1 && !NEUTRAL.has(w));

/** plainWords with adjectives in their base form, for comparing. */
const words = (s: string) => plainWords(s).map((w) => BASE[w] ?? w);

/** Regular plural and diminutive endings: "uien", "appeltjes". Irregular ones like "eieren" are not covered. */
const ENDINGS = ["s", "en", "n", "tje", "tjes"];

const sameWord = (a: string, b: string) => a === b || ENDINGS.some((e) => b === a + e || a === b + e);

/**
 * How well a product title names an ingredient: matched ingredient words, minus 0.1 per other title
 * word, which ready meals and mixes have many of, and 0.3 more per product type (yoghurt, crackers) the
 * ingredient doesn't name. A word or its plural counts 1. Dutch compounds end in
 * their noun, so a shared end counts 0.75 ("tarwebloem" is flour) and a shared start only 0.25
 * ("bloemkool" is not); both need 4+ letters in common.
 */
function matchScore(ingredient: string, title: string): number {
  const want = words(ingredient);
  const have = words(title);
  if (want.length === 0) return 0;
  const used = new Set<string>();
  let matched = 0;
  for (const w of want) {
    let best = 0;
    let bestWord = "";
    for (const t of have) {
      const long = Math.min(t.length, w.length) >= 4;
      const score = sameWord(w, t)
        ? 1
        : long && (t.endsWith(w) || w.endsWith(t))
          ? 0.75
          : long && (t.startsWith(w) || w.startsWith(t))
            ? 0.25
            : 0;
      if (score > best) [best, bestWord] = [score, t];
    }
    matched += best;
    if (bestWord) used.add(bestWord);
  }
  if (matched === 0) return 0;
  const extra = have.filter((t) => !used.has(t)).length;
  // Matched words count too: "zoutjes" (a snack) is not "zout".
  const flavoured = have.filter((t) => !want.includes(t) && PRODUCT_TYPES.some((type) => t.endsWith(type))).length;
  return matched / want.length - 0.1 * extra - 0.3 * flavoured;
}

/** The best-named product for an ingredient; among equally good ones, one on bonus if preferBonus. */
function pickProduct(ingredient: string, products: Product[], preferBonus: boolean): Product | undefined {
  const scored = products.map((p) => ({ p, score: matchScore(ingredient, p.title) })).filter((x) => x.score > 0);
  if (scored.length === 0) return undefined;
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best).map((x) => x.p);
  return (preferBonus && top.find((p) => p.isBonus)) || top[0];
}

export function registerRecipeTools(server: McpServer, ctx: ToolContext): void {
  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_search_recipes",
      title: "Albert Heijn: Search Recipes",
      kind: "readOnly",
      description:
        "Search Allerhande, Albert Heijn's recipe collection. Dutch search terms work best, " +
        "e.g. 'pasta', 'stamppot', 'kip curry'; a recipe matches when it has all the words. " +
        "filters narrows results to recipes matching all of them, e.g. ['vegetarian', 'quick', 'italian']: " +
        "a label (easy, quick, budget, healthy, light), course (main_course, lunch, dessert, ...), " +
        "dish (pasta, soup, salad, ...), main ingredient (meat, fish, ...), diet (vegan, gluten_free, ...), " +
        "occasion, season, cooking method (oven, airfryer, ...) or cuisine (italian, asian, ...). " +
        "query may be left out to browse by filters alone. " +
        "sort orders results: relevance (default), newest, popular. " +
        "Returns id, title, url, cook_minutes, servings, courses, nutri_score, rating, and corrected_query " +
        "when AH fixed a typo. Use the id with ah_get_recipe for ingredients and steps.",
      input: {
        query: z.string().optional().describe("Search text, e.g. 'pasta zalm'"),
        filters: z
          .array(z.enum(Object.keys(RECIPE_FILTERS) as [RecipeFilterName, ...RecipeFilterName[]]))
          .optional()
          .describe('Only recipes matching all of these, e.g. ["vegetarian", "quick"]'),
        sort: z
          .enum(Object.keys(RECIPE_SORTS) as [RecipeSortName, ...RecipeSortName[]])
          .optional()
          .describe("Result order (default relevance)"),
        limit: z.number().int().optional().describe("Maximum number of results (default 10, max 30)"),
      },
      output: {
        total: z.number(),
        corrected_query: str,
        recipes: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            url: z.string(),
            cook_minutes: num,
            oven_minutes: num,
            wait_minutes: num,
            servings: str,
            courses: strs,
            nutri_score: str,
            rating: str,
          }),
        ),
      },
    },
    async (c, args) => {
      const text = args.query?.trim() ?? "";
      const filters = recipeFilters(args.filters ?? []);
      if (!text && filters.length === 0) throw new Error("provide a query, filters, or both");
      const { total, recipes, correctedText } = await searchRecipes(c, text, Math.min(orDefault(args.limit, 10), 30), {
        filters,
        sort: RECIPE_SORTS[args.sort ?? "relevance"],
      });
      // A message replaces the JSON text, so only an empty result gets one; corrected_query carries a correction.
      const searchedText = correctedText ? `"${correctedText}" (corrected from "${text}")` : text && `"${text}"`;
      const searched = [searchedText, args.filters?.length && `filters ${args.filters.join(", ")}`]
        .filter(Boolean)
        .join(" with ");
      const message = recipes.length ? undefined : `No recipes found for ${searched}.`;
      return structured(
        {
          total,
          corrected_query: correctedText,
          recipes: recipes.map((r) => ({
            id: r.id,
            title: r.title,
            url: recipeUrl(r.id, r.slug),
            cook_minutes: r.time?.cook || undefined,
            oven_minutes: r.time?.oven || undefined,
            wait_minutes: r.time?.wait || undefined,
            servings: r.serving ? `${r.serving.number} ${r.serving.type}` : undefined,
            courses: r.courses?.length ? r.courses : undefined,
            nutri_score: r.nutriScore || undefined,
            rating: rating(r.rating),
          })),
        },
        message,
      );
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_recipe",
      title: "Albert Heijn: Recipe",
      kind: "readOnly",
      description:
        "Get an Allerhande recipe by id: ingredients, preparation steps, and nutrition per serving. " +
        "Set servings to scale the ingredient quantities. " +
        "To shop for it, search the ingredients with ah_search_products and add them with ah_add_to_shopping_list.",
      input: {
        recipe_id: z.number().int().describe("Recipe id from ah_search_recipes"),
        servings: z.number().int().optional().describe("Number of servings to scale the ingredients to"),
      },
      output: {
        id: z.number(),
        title: z.string(),
        url: z.string(),
        description: str,
        cook_minutes: num,
        servings: z.string(),
        courses: strs,
        cuisines: strs,
        nutri_score: str,
        rating: str,
        ingredients: z.array(z.string()),
        steps: z.array(z.string()),
        nutrition_per_serving: z.record(z.string(), z.string()).optional(),
      },
    },
    async (c, args) => {
      if (args.recipe_id <= 0) throw new Error("recipe_id is required");
      const servings = args.servings && args.servings > 0 ? args.servings : undefined;
      const r = await getRecipe(c, args.recipe_id, servings).catch((err: unknown) => {
        // AH redacts the reason, which is usually an unknown id. The cause keeps a 401 visible.
        throw wrapError(`could not get recipe ${args.recipe_id}; check the id`, err);
      });
      const n = r.nutritions;
      return structured({
        id: r.id,
        title: r.title,
        url: ahPageUrl(r.href, recipeUrl(r.id, "")),
        description: r.description || undefined,
        cook_minutes: r.cookTime || undefined,
        servings: `${servings ?? r.servings.number} ${r.servings.type}`,
        courses: r.courses?.length ? r.courses : undefined,
        cuisines: r.cuisines?.length ? r.cuisines : undefined,
        nutri_score: r.nutriScore || undefined,
        rating: rating(r.rating),
        ingredients: r.ingredients.map((i) => i.text),
        steps: r.preparation?.steps ?? [],
        nutrition_per_serving: n
          ? Object.fromEntries(
              Object.values(n)
                .filter((x) => x != null)
                .map((x) => [x.name, `${x.value} ${x.unit}`]),
            )
          : undefined,
      });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_add_recipe_to_shopping_list",
      title: "Albert Heijn: Add Recipe to Shopping List",
      kind: "additive",
      description:
        "Put the ingredients of an Allerhande recipe on the shopping list in one step. " +
        "Each ingredient is matched to the AH product whose name fits it best (among equally good matches, " +
        "one on bonus unless prefer_bonus=false); " +
        "one unit of each product is added. Water is always skipped; pass skip for anything the user already has " +
        "(e.g. olive oil, salt). Set dry_run=true to show the matches without adding them. " +
        "Returns the added, skipped and unmatched ingredients, and any whose search failed (worth retrying).",
      input: {
        recipe_id: z.number().int().describe("Recipe id from ah_search_recipes"),
        servings: z.number().int().optional().describe("Number of servings, as in ah_get_recipe"),
        skip: z.array(z.string()).optional().describe('Ingredients to leave out, matched by name, e.g. ["olijfolie", "zout"]'),
        prefer_bonus: z.boolean().optional().describe("Prefer a matching product on bonus (default true)"),
        dry_run: z.boolean().optional().describe("Only show the matches; don't add anything"),
      },
      output: {
        recipe: z.string(),
        added: z.array(z.object({ ingredient: z.string(), product: productSummary })),
        skipped: z.array(z.string()),
        not_found: z.array(z.string()),
        /** Searches that failed (e.g. AH unavailable); unlike not_found, these may exist. */
        failed: z.array(z.string()),
        dry_run: z.boolean(),
      },
    },
    async (c, args) => {
      if (args.recipe_id <= 0) throw new Error("recipe_id is required");
      const servings = args.servings && args.servings > 0 ? args.servings : undefined;
      const recipe = await getRecipe(c, args.recipe_id, servings).catch((err: unknown) => {
        throw wrapError(`could not get recipe ${args.recipe_id}; check the id`, err);
      });
      // A skip entry matches an ingredient containing all its words, so "zout" skips "zout en peper" but not "ongezouten boter".
      const skips = (args.skip ?? []).map(words).filter((w) => w.length > 0);
      const isSkipped = (name: string) => {
        const have = words(name);
        return have.some((w) => TAP_WATER.has(w)) || skips.some((s) => s.every((w) => have.some((t) => sameWord(w, t))));
      };
      const wanted = recipe.ingredients.filter((i) => !isSkipped(i.name));

      const matches: (Product | undefined)[] = new Array(wanted.length);
      const errors: (unknown | undefined)[] = new Array(wanted.length);
      await parallel(wanted.length, 3, async (i) => {
        const name = wanted[i]!.name;
        // Packaging and filler words ("uit blik") only confuse AH's search.
        const query = plainWords(name).join(" ") || name;
        const products = await nonFatal(
          () => search(ctx, c, query, CANDIDATES, { sort: "RELEVANCE" }),
          (err) => {
            errors[i] = err;
            return [];
          },
        );
        matches[i] = pickProduct(name, products, args.prefer_bonus !== false);
      });
      if (wanted.length > 0 && errors.filter(Boolean).length === wanted.length) {
        throw wrapError("could not search for the ingredients", errors[0]);
      }

      const added = wanted.flatMap((ing, i) => {
        const p = matches[i];
        return p ? [{ ingredient: ing.text, product: summarizeProduct(p) }] : [];
      });
      const quantities = new Map(added.map((a) => [a.product.id, 1]));
      if (!args.dry_run && quantities.size > 0) {
        await listCall("failed to add the ingredients", () => addProductsToShoppingList(c, quantities));
      }
      return structured({
        recipe: recipe.title,
        added,
        skipped: recipe.ingredients.filter((i) => isSkipped(i.name)).map((i) => i.text),
        not_found: wanted.filter((_, i) => !matches[i] && !errors[i]).map((i) => i.text),
        failed: wanted.filter((_, i) => errors[i]).map((i) => i.text),
        dry_run: Boolean(args.dry_run),
      });
    },
  );

  addAuthedTool(
    server,
    ctx,
    {
      name: "ah_get_meal_plan",
      title: "Albert Heijn: Meal Plan",
      kind: "readOnly",
      description:
        "Get the user's meal plan from the Albert Heijn app's weekplanner, per day from today (about two weeks): " +
        "planned Allerhande recipes, their own recipes, products and notes. " +
        "Use the recipe_id of a planned Allerhande recipe with ah_get_recipe or ah_add_recipe_to_shopping_list, " +
        "e.g. to shop for the week's dinners; the user's own recipes (own_recipe_id) can't be opened with those tools. " +
        "incomplete=true means AH failed on some days or entries, so some may be missing or shown as type other. Planning recipes is done in the AH app.",
      input: {
        include_empty_days: z.boolean().optional().describe("Also list days with nothing planned (default false)"),
      },
      output: {
        incomplete: z.boolean().optional(),
        days: z.array(
          z.object({
            date: z.string(),
            items: z.array(
              z.object({
                type: z.enum(["recipe", "own_recipe", "product", "note", "other"]),
                title: z.string(),
                recipe_id: z.number().optional(),
                own_recipe_id: z.number().optional(),
                product_id: z.number().optional(),
                url: z.string().optional(),
              }),
            ),
          }),
        ),
      },
    },
    async (c, args) => {
      const { days: plan, incomplete } = await getMealPlan(c);
      const days = plan
        .filter((d) => args.include_empty_days || d.items.length > 0)
        .map((d) => ({
          date: d.date,
          items: d.items.map((i) => {
            switch (i.kind) {
              case "recipe":
                return { type: i.kind, title: i.title ?? UNTITLED, recipe_id: i.recipeId, url: i.slug ? recipeUrl(i.recipeId, i.slug) : undefined };
              case "own_recipe":
                return { type: i.kind, title: i.title ?? UNTITLED, own_recipe_id: i.recipeId };
              case "product":
                // Without a title there's no slug; the id alone still finds the product.
                return { type: i.kind, title: i.title ?? UNTITLED, product_id: i.productId, url: productUrl(i.productId, i.title) };
              case "note":
                return { type: i.kind, title: i.text || "(empty note)" };
              case "other":
                return { type: i.kind, title: i.title ?? "an entry this server can't show; see the AH app" };
            }
          }),
        }));
      const range = plan.length ? ` from ${plan[0]!.date} to ${plan.at(-1)!.date}` : "";
      return structured(
        { days, incomplete: incomplete || undefined },
        plan.some((d) => d.items.length)
          ? undefined
          : incomplete
            ? "Some of the meal plan could not be loaded from AH, and the rest is empty; check the AH app."
            : `The meal plan is empty${range}. Recipes are planned in the AH app.`,
      );
    },
  );
}

function rating(r: { average?: number | null; count?: number | null } | null | undefined): string | undefined {
  return r?.average && r.count ? `${r.average.toFixed(1)}/5 (${r.count})` : undefined;
}
