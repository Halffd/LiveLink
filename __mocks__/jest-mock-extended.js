// Mock for jest-mock-extended
export const mock = jest.fn((obj) => ({
  ...obj,
  _isMockProxy: true,
}));

export const mockReset = jest.fn();
export const mockClear = jest.fn();

export const MockProxy = {
  create: jest.fn(),
};

export default {
  mock,
  mockReset,
  mockClear,
  MockProxy,
}; 