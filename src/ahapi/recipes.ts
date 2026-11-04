import { log } from "../log.ts";
import type { AhClient } from "./client.ts";

/** Allerhande recipe search result. */
export interface RecipeSummary {
  id: number;
  title: string;
  slug: string;
  nutriScore?: string | null;
  courses?: string[];
  time?: { cook?: number | null; oven?: number | null; wait?: number | null };
  serving?: { number: number; type: string };
  rating?: { average?: number | null; count?: number | null } | null;
}

export interface Nutrition {
  value: number;
  unit: string;
  name: string;
}

export interface Recipe {
  id: number;
  title: string;
  description?: string | null;
  href: string;
  cookTime?: number | null;
  nutriScore?: string | null;
  courses?: string[];
  cuisines?: string[];
  servings: { number: number; type: string };
  rating?: { average?: number | null; count?: number | null } | null;
  /** text is the full line ("2 middelgrote uien"); name the ingredient alone ("middelgrote ui"). */
  ingredients: { text: string; name: string }[];
  preparation?: { steps?: string[] } | null;
  nutritions?: Record<"energy" | "carbohydrates" | "fat" | "protein", Nutrition | null> | null;
}

const AH_WEB = new URL("https://www.ah.nl/");

export function recipeUrl(id: number, slug: string): string {
  return new URL(`/allerhande/recept/R-R${id}/${encodeURIComponent(slug)}`, AH_WEB).href;
}

/** href (a path from AH) on www.ah.nl, or fallback if it would lead to another site. */
export function ahPageUrl(href: string, fallback: string): string {
  const url = URL.parse(href, AH_WEB.href);
  return url?.origin === AH_WEB.origin ? url.href : fallback;
}

/** AH returns HTML entities in recipe text, e.g. "1&#189; teen". */
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      // Beyond Unicode, fromCodePoint throws: leave such an entity as written.
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

export type RecipeSort = "MOST_RELEVANT" | "NEWEST" | "POPULAR";

/** A recipe must match every filter and, within a filter, every value. */
export interface RecipeFilter {
  /** Filter group, e.g. "keuken". */
  group: string;
  /** Values within the group, e.g. ["italiaans"]. */
  values: string[];
}

export interface RecipeSearchOptions {
  filters: RecipeFilter[];
  sort: RecipeSort;
}

export interface RecipeSearchResult {
  total: number;
  recipes: RecipeSummary[];
  /** The text AH searched for instead, when it corrected a typo. */
  correctedText?: string;
}

/** Empty text lists all recipes matching the filters. */
export async function searchRecipes(c: AhClient, text: string, size: number, opts: RecipeSearchOptions): Promise<RecipeSearchResult> {
  const query = `query RecipeSearch($searchText: String, $size: PageSize, $sortBy: RecipeSearchSortOption, $filters: [RecipeSearchQueryFilter!]) {
  recipeSearchV2(searchText: $searchText, size: $size, sortBy: $sortBy, filters: $filters, recipeIds: []) {
    correctedSearchTerm
    page { total }
    result { id title slug nutriScore courses time { cook oven wait } serving { number type } rating { average count } }
  }
}`;
  const { recipeSearchV2: data } = await c.graphql<{
    recipeSearchV2: { correctedSearchTerm?: string | null; page?: { total: number }; result: RecipeSummary[] };
  }>(query, { searchText: text, size, sortBy: opts.sort, filters: opts.filters });
  return {
    total: data.page?.total ?? 0,
    recipes: data.result.map((r) => ({ ...r, title: decodeEntities(r.title) })),
    correctedText: data.correctedSearchTerm || undefined,
  };
}

/** servings scales the ingredient quantities; AH still reports the default in recipe.servings. */
export async function getRecipe(c: AhClient, id: number, servings?: number): Promise<Recipe> {
  const query = `query Recipe($id: Int!, $servings: Int) {
  recipe(id: $id, servings: $servings) {
    id title description href cookTime nutriScore courses cuisines
    servings { number type }
    rating { average count }
    ingredients { text name { singular } }
    preparation { steps }
    nutritions {
      energy { value unit name } carbohydrates { value unit name }
      fat { value unit name } protein { value unit name }
    }
  }
}`;
  const { recipe: r } = await c.graphql<{
    recipe: Omit<Recipe, "ingredients"> & { ingredients: { text: string; name?: { singular?: string } | null }[] };
  }>(query, { id, servings });
  return {
    ...r,
    title: decodeEntities(r.title),
    description: r.description && decodeEntities(r.description),
    ingredients: r.ingredients.map((i) => ({
      text: decodeEntities(i.text),
      name: decodeEntities(i.name?.singular || i.text),
    })),
    preparation: r.preparation && { steps: r.preparation.steps?.map(decodeEntities) },
  };
}

/** An entry of the AH app's meal planner (weekplanner): a recipe, the member's own recipe, a product or a note. */
export type PlannerItem =
  | { kind: "recipe"; recipeId: number; title?: string; slug?: string }
  | { kind: "own_recipe"; recipeId: number; title?: string }
  | { kind: "product"; productId: number; title?: string }
  | { kind: "note"; text: string }
  /** An entry of a kind this server doesn't know, or missing its id, so it isn't hidden. */
  | { kind: "other"; title?: string };

/**
 * The planner from today, one entry per day (AH returns two weeks), with what is planned on it.
 * incomplete: AH failed on some days or entries, so the plan may be missing some.
 */
export async function getMealPlan(c: AhClient): Promise<{ days: { date: string; items: PlannerItem[] }[]; incomplete: boolean }> {
  const query = `query MealPlan {
  recipeWeekPlannerOverview {
    days {
      date
      items {
        __typename
        ... on WeekPlannerRecipeItem { recipeId recipeTitle recipe { slug } }
        ... on WeekPlannerMemberRecipeItem { recipeId recipeTitle }
        ... on WeekPlannerNoteItem { text }
        ... on WeekPlannerProductItem { productId productTitle }
      }
    }
  }
}`;
  type RawItem = {
    __typename?: string;
    recipeId?: number | null;
    recipeTitle?: string | null;
    recipe?: { slug?: string | null } | null;
    text?: string | null;
    productId?: number | null;
    productTitle?: string | null;
  };
  // An entry AH fails to resolve (e.g. an unpublished recipe) comes back null without losing the other days.
  const { data, errors } = await c.graphqlPartial<{
    recipeWeekPlannerOverview?: { days?: ({ date: string; items?: (RawItem | null)[] | null } | null)[] | null } | null;
  }>(query);
  const days = data?.recipeWeekPlannerOverview?.days;
  // With errors, no days, or days that all failed, is a failed fetch; an empty list is an empty plan.
  if (!data || (errors && (!days || (days.length > 0 && !days.some(Boolean))))) throw errors ?? new Error("AH returned no meal plan");
  if (errors) log.warn("some meal plan entries could not be fetched", { err: errors });
  // undefined when AH sent no title.
  const titleOf = (t: string | null | undefined) => (t ? decodeEntities(t) : undefined);
  const toItem = (i: RawItem | null): PlannerItem => {
    if (!i) return { kind: "other" };
    switch (i.__typename) {
      case "WeekPlannerRecipeItem":
        if (i.recipeId) {
          return { kind: "recipe", recipeId: i.recipeId, title: titleOf(i.recipeTitle), slug: i.recipe?.slug ?? undefined };
        }
        break;
      case "WeekPlannerMemberRecipeItem":
        if (i.recipeId) return { kind: "own_recipe", recipeId: i.recipeId, title: titleOf(i.recipeTitle) };
        break;
      case "WeekPlannerProductItem":
        if (i.productId) return { kind: "product", productId: i.productId, title: titleOf(i.productTitle) };
        break;
      case "WeekPlannerNoteItem":
        return { kind: "note", text: decodeEntities(i.text ?? "") };
    }
    // A kind this server doesn't know, or an entry missing its id: shown, not hidden.
    const title = i.recipeTitle ?? i.productTitle ?? i.text;
    return { kind: "other", title: title ? decodeEntities(title) : undefined };
  };
  // No planner yet (never used) is an empty plan; a day AH fails to resolve comes back null and is left out.
  return {
    days: (days ?? []).flatMap((d) => (d ? [{ date: d.date, items: (d.items ?? []).map(toItem) }] : [])),
    incomplete: Boolean(errors),
  };
}
