const InventoryService = require('../services/InventoryService');

// Mock Supabase
const mockSupabase = {
    from: jest.fn(),
};

describe('InventoryService', () => {
    let service;

    beforeEach(() => {
        service = new InventoryService(mockSupabase);
        jest.clearAllMocks();
    });

    describe('getSlots', () => {
        it('should return formatted slots', async () => {
            const mockSlots = [
                { time: '08:00:00', status: 'available', is_open: true },
                { time: '09:00:00', status: 'booked', is_open: true }
            ];

            const chain = {
                select: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis(),
                order: jest.fn().mockResolvedValue({ data: mockSlots, error: null })
            };
            mockSupabase.from.mockReturnValue(chain);

            const result = await service.getSlots('2023-10-10');
            expect(result).toHaveLength(2);
            expect(result[0].isBooked).toBe(false);
            expect(result[1].isBooked).toBe(true);
        });
    });

    describe('attemptBooking', () => {
        it('should lock an available slot', async () => {
            const mockSlot = { id: 'slot-1', status: 'available' };

            // Mock finding the slot
            const selectChain = {
                select: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis(),
                single: jest.fn().mockResolvedValue({ data: mockSlot, error: null })
            };

            // Mock locking the slot
            const updateChain = {
                update: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis(),
                select: jest.fn().mockResolvedValue({ data: [{ id: 'slot-1' }], error: null })
            };

            mockSupabase.from.mockImplementation((table) => {
                if (table === 'daily_slots') {
                     // We need to differentiate between the select and update calls
                     // First call is select, second is update.
                     // But jest mocks are tricky with state.
                     return {
                         ...selectChain,
                         ...updateChain
                     }
                }
            });

            // Adjust mock implementation to separate behaviors if needed,
            // but since we call different methods (select vs update) it might clash if object is same.
            // Let's refine the mock.
            // Create separate mock objects for select query and update query
            const selectQuery = {
                eq: jest.fn().mockReturnThis(),
                single: jest.fn().mockResolvedValue({ data: mockSlot, error: null })
            };

            const updateQuery = {
                eq: jest.fn().mockReturnThis(),
                select: jest.fn().mockResolvedValue({ data: [{ id: 'slot-1' }], error: null })
            };

            const queryBuilder = {
                select: jest.fn().mockReturnValue(selectQuery), // select() returns the chainable object
                update: jest.fn().mockReturnValue(updateQuery), // update() returns the chainable object
            };
            mockSupabase.from.mockReturnValue(queryBuilder);

            const result = await service.attemptBooking('user-1', '2023-10-10', '08:00');
            expect(result).toBe('slot-1');
            expect(queryBuilder.update).toHaveBeenCalledWith({ status: 'locked' });
        });

        it('should throw if slot is not available', async () => {
             const mockSlot = { id: 'slot-1', status: 'booked' };
             const queryBuilder = {
                select: jest.fn().mockReturnThis(),
                eq: jest.fn().mockReturnThis(),
                single: jest.fn().mockResolvedValue({ data: mockSlot, error: null })
            };
            mockSupabase.from.mockReturnValue(queryBuilder);

            await expect(service.attemptBooking('user-1', '2023-10-10', '08:00'))
                .rejects.toThrow('Slot is already booked or locked');
        });
    });
});
