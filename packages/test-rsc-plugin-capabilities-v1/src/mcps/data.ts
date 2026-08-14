export const products = Object.freeze([
  { id: 'p-100', name: 'Standing Desk', category: 'office', price: 399 },
  { id: 'p-101', name: 'Desk Lamp', category: 'office', price: 49 },
  { id: 'p-102', name: 'Desk Mat', category: 'office', price: 29 },
  { id: 'p-200', name: 'Travel Mug', category: 'lifestyle', price: 25 },
]);

export const findProduct = (id: string) => products.find(product => product.id === id);
