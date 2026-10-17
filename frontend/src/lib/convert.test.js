import test from 'node:test'
import assert from 'node:assert/strict'
import { convertLine, convertTemperatures, displayIngredient } from './convert.js'

const metric = (line) => convertLine(line, 'metric')
const us = (line) => convertLine(line, 'us')

test('original, or an unknown mode, changes nothing', () => {
  for (const line of ['1 cup (200g) sugar', '2 cups flour', '8 oz butter']) {
    assert.equal(convertLine(line, 'original'), line)
    assert.equal(convertLine(line, undefined), line)
  }
})

test('a US weight becomes grams, rounded the way a scale reads', () => {
  assert.equal(metric('8 oz butter'), '225 g butter')
  assert.equal(metric('1 lb ground beef'), '450 g ground beef')
  assert.equal(metric('2 oz parmesan'), '55 g parmesan')
  assert.equal(metric('2 lb potatoes'), '900 g potatoes')
  assert.equal(metric('4 lb chicken'), '1.8 kg chicken')
})

test('a US volume of a liquid becomes millilitres, and a cup is 240', () => {
  assert.equal(metric('1 cup milk'), '240 ml milk')
  assert.equal(metric('1/2 cup water'), '120 ml water')
  assert.equal(metric('1/3 cup olive oil'), '80 ml olive oil')
  assert.equal(metric('2 cups chicken stock'), '480 ml chicken stock')
  assert.equal(metric('4 cups broth'), '960 ml broth')
  assert.equal(metric('8 fl oz cream'), '240 ml cream')
  assert.equal(metric('1 quart stock'), '960 ml stock')
  assert.equal(metric('1 gallon milk'), '3.84 l milk')
})

test('a cup of a baking staple becomes grams, marked approximate', () => {
  assert.equal(metric('1 cup all-purpose flour'), '≈125 g all-purpose flour')
  assert.equal(metric('2 cups sugar'), '≈400 g sugar')
  assert.equal(metric('1 cup packed brown sugar'), '≈215 g packed brown sugar')
  assert.equal(metric('1 cup butter'), '≈225 g butter')
  assert.equal(metric('1 cup rolled oats'), '≈90 g rolled oats')
})

test('a cup of anything else stays a cup rather than being guessed at', () => {
  assert.equal(metric('1 cup chopped walnuts'), '1 cup chopped walnuts')
  assert.equal(metric('2 cups spinach'), '2 cups spinach')
  // Look-alikes that are not the staple.
  assert.equal(metric('1 cup almond flour'), '1 cup almond flour')
  assert.equal(metric('1 cup peanut butter'), '1 cup peanut butter')
  assert.equal(metric('1 cup cream cheese'), '1 cup cream cheese')
  assert.equal(metric('1 cup coconut sugar'), '1 cup coconut sugar')
  assert.equal(metric('1 cup rice vinegar'), '240 ml rice vinegar')
})

test('spoons stay spoons in a metric kitchen', () => {
  assert.equal(metric('1 tsp salt'), '1 tsp salt')
  assert.equal(metric('2 tbsp olive oil'), '2 tbsp olive oil')
})

test('metric measures become US ones, at the size a person reads', () => {
  assert.equal(us('240 ml milk'), '1 cup milk')
  assert.equal(us('500 ml water'), '2 cups water')
  assert.equal(us('15 ml oil'), '1 tbsp oil')
  assert.equal(us('5 ml vanilla'), '1 tsp vanilla')
  assert.equal(us('1 l stock'), '1 quart stock')
  assert.equal(us('200 g cheddar'), '7 oz cheddar')
  assert.equal(us('1 kg potatoes'), '2 1/4 lb potatoes')
})

test('grams of a baking staple become cups, marked approximate', () => {
  assert.equal(us('250 g flour'), '≈2 cups flour')
  assert.equal(us('200 g sugar'), '≈1 cup sugar')
  // Butter is a weight in US recipes too (sticks, ounces), so it stays one.
  assert.equal(us('225 g butter'), '8 oz butter')
})

test('a line already in the chosen system is left exactly alone', () => {
  assert.equal(metric('200 g flour'), '200 g flour')
  assert.equal(us('1 cup milk'), '1 cup milk')
  assert.equal(us('2 tbsp butter'), '2 tbsp butter')
})

test('a bracketed restatement is used when it is in the system asked for', () => {
  assert.equal(metric('1 cup (200g) sugar'), '200 g sugar')
  assert.equal(metric('1 cup (240 ml) milk, warmed'), '240 ml milk, warmed')
  assert.equal(us('1 cup (200g) sugar'), '1 cup (200g) sugar')
  assert.equal(us('200 g (7 oz) cheddar'), '7 oz cheddar')
})

test('a bracket after a container, or straight after the number, is a size and is kept', () => {
  assert.equal(metric('1 can (400 g) tomatoes'), '1 can (400 g) tomatoes')
  assert.equal(metric('2 (14 oz) cans beans'), '2 (14 oz) cans beans')
})

test('a range keeps its separator and one unit', () => {
  assert.equal(metric('1 to 2 lb chicken'), '450 to 900 g chicken')
  assert.equal(metric('2-3 cups milk'), '480-720 ml milk')
  assert.equal(us('500-750 ml stock'), '2-3 cups stock')
})

test('a bullet, fractions and plural units survive', () => {
  assert.equal(metric('- 1 1/2 cups milk'), '- 360 ml milk')
  assert.equal(us('• 750 ml water'), '• 3 cups water')
  assert.equal(us('1000 ml water'), '1 quart water')
})

test('an amount too small to write in the other system is left as written, never "0 oz"', () => {
  assert.equal(us('1 g saffron'), '1 g saffron')
  assert.equal(us('3 g salt'), '3 g salt')
  assert.equal(us('2 g cinnamon'), '2 g cinnamon')
  // Just big enough to be written.
  assert.equal(us('10 g yeast'), '1/3 oz yeast')
  assert.equal(us('1/8 tsp saffron'), '1/8 tsp saffron')
})

test('look-alikes of the density staples are not marked approximate', () => {
  assert.equal(metric('1 cup flour tortillas'), '1 cup flour tortillas')
  assert.equal(metric('1 cup cauliflower rice'), '1 cup cauliflower rice')
  assert.equal(metric('1 cup steel cut oats'), '1 cup steel cut oats')
  assert.equal(metric('1 cup bread flour'), '1 cup bread flour')
})

test('lines with no measure are returned exactly as written', () => {
  for (const line of ['3 cloves garlic', '2 eggs', 'salt to taste', '1 can tomatoes', '', 'a handful of basil']) {
    assert.equal(metric(line), line)
    assert.equal(us(line), line)
  }
  assert.equal(metric(null), null)
})

test('a unit mistaken for a word is not converted ("1 c" is a cup, "1 cheese" is not)', () => {
  assert.equal(metric('1 cheese board'), '1 cheese board')
  assert.equal(metric('2 gallons of milk'), '7.68 l of milk')
})

test('scaling and converting compose, scaling first', () => {
  assert.equal(displayIngredient('1 cup milk', { factor: 2, units: 'metric' }), '480 ml milk')
  assert.equal(displayIngredient('1 cup (200g) sugar', { factor: 2, units: 'metric' }), '400 g sugar')
  // Original leaves the scaler's output alone, including its habit of not
  // pluralising ("the unit's own spelling survives").
  assert.equal(displayIngredient('1 cup milk', { factor: 2, units: 'original' }), '2 cup milk')
  assert.equal(displayIngredient('8 oz butter', { units: 'metric' }), '225 g butter')
})

test('oven temperatures convert, in fives', () => {
  assert.equal(convertTemperatures('Bake at 350°F for 20 minutes.', 'metric'), 'Bake at 175°C for 20 minutes.')
  assert.equal(convertTemperatures('Preheat to 425°F.', 'metric'), 'Preheat to 220°C.')
  // The pairs cookbooks use, not the arithmetic ones: 180 C is 356 F and every
  // recipe says 350.
  assert.equal(convertTemperatures('Heat to 180°C.', 'us'), 'Heat to 350°F.')
  assert.equal(convertTemperatures('Heat to 200 degrees C.', 'us'), 'Heat to 400°F.')
  assert.equal(convertTemperatures('Heat to 190ºC.', 'us'), 'Heat to 375°F.')
  // Off the table, nearest five.
  assert.equal(convertTemperatures('Heat to 165°C.', 'us'), 'Heat to 330°F.')
})

test('a temperature that is not an oven is not forced onto an oven pair', () => {
  // 100 C is boiling water (212 F), not 200 F.
  assert.equal(convertTemperatures('Bring to 100°C.', 'us'), 'Bring to 210°F.')
  assert.equal(convertTemperatures('Cook the syrup to 110°C.', 'us'), 'Cook the syrup to 230°F.')
})

test('a range of temperatures converts both ends', () => {
  assert.equal(convertTemperatures('Roast at 375-400°F.', 'metric'), 'Roast at 190-200°C.')
})

test('a temperature already given both ways is not converted twice', () => {
  assert.equal(convertTemperatures('Bake at 180°C (350°F).', 'metric'), 'Bake at 180°C (350°F).')
  assert.equal(convertTemperatures('Bake at 350°F/180°C.', 'us'), 'Bake at 350°F/180°C.')
})

test('a temperature already in the chosen scale, and original mode, are unchanged', () => {
  assert.equal(convertTemperatures('Bake at 350°F.', 'us'), 'Bake at 350°F.')
  assert.equal(convertTemperatures('Bake at 350°F.', 'original'), 'Bake at 350°F.')
  assert.equal(convertTemperatures('Bake 350 minutes.', 'metric'), 'Bake 350 minutes.')
  assert.equal(convertTemperatures('', 'metric'), '')
})
