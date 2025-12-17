const AntiAbuseService = require('../services/AntiAbuseService');

// Mock Supabase Client
const mockSupabase = {
  from: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  single: jest.fn(),
  in: jest.fn().mockReturnThis(),
  gte: jest.fn().mockReturnThis(),
  lte: jest.fn().mockReturnThis()
};

describe('AntiAbuseService', () => {
  let service;

  beforeEach(() => {
    service = new AntiAbuseService(mockSupabase);
    jest.clearAllMocks();
  });

  describe('checkUserStatus', () => {
    it('should throw if user is blocked', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: { blocked: true, throttled: false },
        error: null
      });

      await expect(service.checkUserStatus('user-1')).rejects.toThrow('User is blocked');
    });

    it('should delay if user is throttled', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: { blocked: false, throttled: true },
        error: null
      });

      const start = Date.now();
      await service.checkUserStatus('user-1');
      const end = Date.now();

      expect(end - start).toBeGreaterThanOrEqual(2900); // Allow some buffer for 3000ms
    }, 6000); // Extend timeout for this test

    it('should pass if user is normal', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: { blocked: false, throttled: false },
        error: null
      });

      await expect(service.checkUserStatus('user-1')).resolves.not.toThrow();
    });
  });

  describe('checkGroupQuota', () => {
    it('should pass if user has no group', async () => {
      mockSupabase.single.mockResolvedValueOnce({ data: { group_id: null } });

      await expect(service.checkGroupQuota('user-1', '2023-10-10')).resolves.not.toThrow();
    });

    it('should throw if group quota exceeded', async () => {
      // 1. Get user group
      mockSupabase.single.mockResolvedValueOnce({ data: { group_id: 'group-1' } });

      // 2. Get group users
      mockSupabase.select.mockReturnThis(); // Reset chain
      // Mock for group users query
      // The chain in service: from('users').select('id').eq('group_id', ...)
      // We need to match the calls roughly or just mock the implementation of the chain

      // Simpler approach: mock implementation of specific calls
      mockSupabase.from.mockImplementation((table) => {
        if (table === 'users') {
          return {
            select: () => ({
              eq: (field, val) => {
                 if (field === 'id') return { single: () => Promise.resolve({ data: { group_id: 'group-1' } }) };
                 if (field === 'group_id') return Promise.resolve({ data: [{ id: 'u1' }, { id: 'u2' }] });
              }
            })
          };
        }
        if (table === 'appointments') {
          return {
             select: () => ({
                 in: () => ({
                     gte: () => ({
                         lte: () => ({
                             in: () => Promise.resolve({ count: 2, error: null }) // Limit is 2
                         })
                     })
                 })
             })
          }
        }
      });

      await expect(service.checkGroupQuota('user-1', '2023-10-10', 2)).rejects.toThrow('Group quota exceeded');
    });
  });
});
