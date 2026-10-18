// The fixture is a real recipe (oliveandmango.com/apple-crumble-cheesecake-bars),
// chosen because it is the case this exists for: butter, sugar, flour, cinnamon and
// vanilla each appear under more than one section. Ingredient lines and steps are
// copied as the page has them.

import test from 'node:test'
import assert from 'node:assert/strict'
import { stepIngredientMap } from './stepIngredients.js'

const SECTIONS = [
  ['For the Crust', [
    '2½ cups graham crackers crumbs',
    '4 tablespoons granulated sugar',
    '1 teaspoon cinnamon',
    '¼ teaspoon ground nutmeg',
    '8 tablespoons (1 stick / ½ cup) unsalted butter, melted',
    'Pinch of salt, optional',
  ]],
  ['For the Crumble Topping', [
    '8 tablespoons (1 stick / ½ cup)  unsalted unsalted butter, melted',
    '1 cup all-purpose flour',
    '1 cup brown sugar',
    '½ cup quick-cooking oats or old fashioned oats',
    '½ teaspoon salt',
    '1 teaspoon ground cinnamon or apple pie spice',
  ]],
  ['For the Apples', [
    '4 tablespoons (¼ cup) unsalted butter',
    '4 large apples (like pink lady or honeycrisp), peeled and diced',
    '⅓ cup brown sugar',
    '1 teaspoon lemon zest',
    '1 teaspoon vanilla extract',
    '1 teaspoon ground cinnamon',
    '2 tablespoon all-purpose flour',
  ]],
  ['For the Cheesecake Filling', [
    '4 blocks full-fat cream cheese (8-ounce each), room temperature',
    '1 cup sour cream or Greek yogurt',
    '1 cup granulated sugar',
    '4 medium eggs',
    '2 teaspoons vanilla extract',
    '2 teaspoons lemon juice',
  ]],
]

const STEPS = [
  ['Pre Heat Oven & Prepare Pan', 'Lightly grease the bottom and sides of a 9×13" baking pan, then line with parchment paper. Set aside.'],
  ['Pre Heat Oven & Prepare Pan', 'Preheat oven to 350°F.'],
  ['For Crust', 'Add graham cracker crumbs, sugar, and spices to a bowl and whisk. Add the melted butter, and stir until moist crumbs.'],
  ['For Crust', 'Empty into prepared pan and press crust into bottom evenly. Transfer to preheated oven and bake 10 minutes.'],
  ['For the Apples', 'Melt the butter in a nonstick skillet over medium-high heat. When the butter is melted and foamy, add the diced apples, cinnamon, vanilla, lemon zest and sugar and stir well. Cook for 3-4 minutes, until the apples get syrupy, then sprinkle in the flour.'],
  ['For the Apples', 'Stir well and cook for another 2-4 minutes or until thick.'],
  ['For the Topping', 'In a medium bowl whisk together the flour, sugar, oats, salt and spices'],
  ['For the Topping', 'Pour the melted butter and using a fork stir and toss until flour is incorporated and clumps starts to form.'],
  ['For the Cheesecake Filling', 'In a clean large mixing bowl, beat the cream cheese and sugar until smooth and creamy using a hand mixer or stand mixer.'],
  ['For the Cheesecake Filling', 'Add vanilla and lemon juice mix until combined'],
  ['For the Cheesecake Filling', 'Add the eggs, one at a time, mixing on low speed until incorporated. Then mix in the sour cream or yogurt.'],
  ['Assemble & Bake', 'Pour the cheesecake filling into the baked and cooled crust and spread into an even layer.'],
  ['Assemble & Bake', 'Top evenly with the sautéed apples and sprinkle the crumble evenly over the top.'],
  ['Assemble & Bake', 'Transfer baking pan to preheated oven and bake for 45-50 minutes, or until the filling is set and the crumble is golden brown.'],
]

const ingredients = SECTIONS.flatMap(([group, lines]) => lines.map((raw) => ({ raw, group })))
const plain = ingredients.map(({ raw }) => ({ raw }))
const instructions = STEPS.map(([, text]) => text)

const withSections = { ingredients, instructions, instruction_groups: STEPS.map(([g]) => g) }
const withoutSections = { ingredients: plain, instructions }

// The ingredient lines a step maps to, as text, in step order.
const lines = (recipe, n) => stepIngredientMap(recipe)[n].map((m) => recipe.ingredients[m.index].raw)
const has = (list, fragment) => list.some((l) => l.includes(fragment))

test('with sections, the crust step gets the crust lines and no other butter', () => {
  const got = lines(withSections, 2)
  assert.ok(has(got, 'graham crackers crumbs'))
  assert.ok(has(got, '4 tablespoons granulated sugar'))
  assert.equal(got.filter((l) => l.includes('butter')).length, 1)
  assert.ok(got.find((l) => l.includes('butter')).startsWith('8 tablespoons (1 stick / ½ cup) unsalted butter'))
  assert.ok(!has(got, 'brown sugar'))
})

test('with sections, "the melted butter" in the topping is the topping butter', () => {
  const m = stepIngredientMap(withSections)[7]
  const butter = m.filter((x) => ingredients[x.index].raw.includes('butter'))
  assert.equal(butter.length, 1)
  assert.equal(ingredients[butter[0].index].group, 'For the Crumble Topping')
  assert.equal(butter[0].shared, false)
})

test('"For the Topping" is the same section as "For the Crumble Topping"', () => {
  const got = lines(withSections, 6)
  assert.ok(has(got, 'all-purpose flour') && has(got, 'brown sugar') && has(got, 'oats') && has(got, '½ teaspoon salt'))
  assert.ok(!has(got, 'granulated sugar'))
})

test('with sections, the apples step takes the apples\' own butter, sugar and flour', () => {
  const got = lines(withSections, 4)
  assert.ok(has(got, '4 tablespoons (¼ cup) unsalted butter'))
  assert.ok(has(got, '⅓ cup brown sugar'))
  assert.ok(has(got, '2 tablespoon all-purpose flour'))
  assert.ok(has(got, 'apples') && has(got, 'vanilla') && has(got, 'lemon zest'))
  assert.ok(has(got, '1 teaspoon ground cinnamon') && !has(got, 'apple pie spice'))
})

test('a step whose section matches none filters nothing', () => {
  // "Assemble & Bake" names no ingredient section; it names no ingredient either.
  assert.deepEqual(stepIngredientMap(withSections)[11], [])
})

test('without sections, lines that sit together in the list settle the tie', () => {
  // Today's saved recipes carry no section names. The crust step names crumbs,
  // sugar and butter; the crumbs line is in the crust block, so the crust's sugar
  // and butter are the ones beside it, not the topping's, apples' or filling's.
  const crust = lines(withoutSections, 2)
  assert.equal(crust.filter((l) => l.includes('butter')).length, 1)
  assert.ok(crust.find((l) => l.includes('butter')).startsWith('8 tablespoons (1 stick / ½ cup) unsalted butter'))
  assert.deepEqual(
    crust.filter((l) => l.includes('sugar')),
    ['4 tablespoons granulated sugar'],
  )
  // The topping step has no unambiguous line at all (butter, flour, sugar and salt
  // each occur under two or more sections), and the tightest set is still the
  // topping block's.
  const topping = lines(withoutSections, 6)
  assert.ok(has(topping, '1 cup all-purpose flour') && has(topping, '1 cup brown sugar') && has(topping, '½ teaspoon salt'))
  assert.ok(!has(topping, '2 tablespoon all-purpose flour') && !has(topping, 'granulated'))
  const melted = lines(withoutSections, 7).filter((l) => l.includes('butter'))
  assert.equal(melted.length, 1)
  assert.ok(melted[0].includes('unsalted unsalted'))
})

test('"the sauce" means every sauce line, not the one nearest the chicken', () => {
  const recipe = {
    ingredients: [
      { raw: '1 tbsp oyster sauce' },
      { raw: '3 tbsp light soy sauce' },
      { raw: '150g chicken breast' },
    ],
    instructions: ['Mix Sauce in a bowl and pour it over the chicken.'],
  }
  assert.deepEqual(lines(recipe, 0), ['1 tbsp oyster sauce', '3 tbsp light soy sauce', '150g chicken breast'])
})

test('when nothing settles the tie, every candidate is returned, flagged shared', () => {
  const recipe = {
    ingredients: [{ raw: '4 tbsp butter' }, { raw: '1 cup flour' }, { raw: '8 tbsp butter' }],
    instructions: ['Melt the butter.'],
  }
  const m = stepIngredientMap(recipe)[0]
  assert.equal(m.length, 2)
  assert.ok(m.every((x) => x.shared))
  // Add a flour in the step and the butter beside it wins.
  const withFlour = { ...recipe, instructions: ['Melt the butter, then whisk in the flour.'] }
  const w = stepIngredientMap(withFlour)[0].map((x) => recipe.ingredients[x.index].raw)
  assert.equal(w.length, 3, 'both butters are one step from the flour, so it is still a tie')
})

test('cream cheese does not pull in the sour cream, and the lemon juice not the zest', () => {
  for (const recipe of [withSections, withoutSections]) {
    const cheese = lines(recipe, 8)
    assert.ok(has(cheese, 'cream cheese'))
    assert.ok(!has(cheese, 'sour cream'))
    const juice = lines(recipe, 9)
    assert.ok(has(juice, 'lemon juice') && has(juice, 'vanilla'))
    assert.ok(!has(juice, 'lemon zest'))
  }
})

test('sour cream or yogurt in a step finds the sour cream line, and the eggs', () => {
  const got = lines(withoutSections, 10)
  assert.ok(has(got, 'sour cream') && has(got, 'eggs'))
  assert.ok(!has(got, 'cream cheese'))
})

test('"spices" and "golden brown" name no ingredient', () => {
  // The crust step says "sugar, and spices": the cinnamon line is not found, and
  // the apple-pie-spice line must not be dragged in by the word "spices".
  assert.ok(!has(lines(withoutSections, 2), 'apple pie spice'))
  assert.ok(!has(lines(withoutSections, 13), 'brown sugar'))
})

test('a step that names nothing returns nothing', () => {
  assert.deepEqual(stepIngredientMap(withoutSections)[1], [])
  assert.deepEqual(stepIngredientMap(withoutSections)[0], [])
})

test('"brown sugar" in the step picks the brown sugar over the granulated', () => {
  const recipe = {
    ingredients: [{ raw: '1 cup granulated sugar' }, { raw: '1 cup brown sugar' }],
    instructions: ['Cream the butter with the brown sugar.', 'Stir in the sugar.'],
  }
  assert.deepEqual(lines(recipe, 0), ['1 cup brown sugar'])
  assert.equal(lines(recipe, 1).length, 2)
})

// Each of these was a wrong line on a real recipe the first time this ran.
test('words that describe an action or a form do not match another line', () => {
  const recipe = {
    ingredients: [
      { raw: '2 cups cooked white rice' },
      { raw: '1 teaspoon baking soda' },
      { raw: '15 oz fire roasted diced tomatoes' },
      { raw: '1 yellow onion, diced' },
      { raw: '1/2 tsp onion powder' },
      { raw: '1 lb. boneless, skinless chicken breast' },
    ],
    instructions: [
      'Scramble the egg until just cooked.',
      'Line the baking sheets with parchment.',
      'Add the diced onion and stir.',
      'Cut the chicken into cubes.',
    ],
  }
  const map = stepIngredientMap(recipe)
  const at = (n) => map[n].map((m) => recipe.ingredients[m.index].raw)
  assert.deepEqual(at(0), [], 'cooked is not rice')
  assert.deepEqual(at(1), [], 'baking sheets are not baking soda')
  assert.deepEqual(at(2), ['1 yellow onion, diced'], 'diced onion is not diced tomatoes or onion powder')
  assert.deepEqual(at(3), ['1 lb. boneless, skinless chicken breast'], 'a comma after "boneless" must not hide the line')
})

test('a step\'s own title is not an ingredient', () => {
  const recipe = {
    ingredients: [{ raw: '2 cups cooked rice' }, { raw: '1 tbsp oil' }],
    instructions: ['Fried Rice: Turn heat up to high and add the oil.'],
  }
  assert.deepEqual(lines(recipe, 0), ['1 tbsp oil'])
})

test('the plain line beats a qualified one the step did not name', () => {
  const recipe = {
    ingredients: [{ raw: '1/2 tsp sesame oil' }, { raw: '2 tbsp oil' }],
    instructions: ['Heat the oil in a wok.'],
  }
  assert.deepEqual(lines(recipe, 0), ['2 tbsp oil'])
})

test('mentions come back in the order the step makes them', () => {
  const recipe = {
    ingredients: [{ raw: '2 eggs' }, { raw: '1 cup flour' }],
    instructions: ['Add the flour, then the eggs.'],
  }
  assert.deepEqual(lines(recipe, 0), ['1 cup flour', '2 eggs'])
})

test('AI-structured lines (item set) and recipes with no steps or ingredients do not throw', () => {
  const structured = {
    ingredients: [{ raw: '2 cups flour', item: 'flour', qty: '2', unit: 'cup' }],
    instructions: ['Sift the flour.'],
  }
  assert.deepEqual(lines(structured, 0), ['2 cups flour'])
  assert.deepEqual(stepIngredientMap({ ingredients: [], instructions: ['x'] }), [[]])
  assert.deepEqual(stepIngredientMap({ ingredients: [{ raw: 'salt' }], instructions: [] }), [])
  assert.deepEqual(stepIngredientMap(undefined), [])
})
