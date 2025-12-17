class InventoryService {
  constructor(supabaseClient) {
    this.supabase = supabaseClient;
  }

  /**
   * Get slots for a specific date
   * @param {string} date
   */
  async getSlots(date) {
    // Inventory Mode: Read from daily_slots
    const { data: slots, error } = await this.supabase
      .from('daily_slots')
      .select('start_time, status, is_open') // ✅ 這裡用 start_time (正確)
      .eq('target_date', date)               // ✅ 修正：改成 target_date
      .eq('is_open', true)
      .order('start_time');

    if (error) throw error;

    // Map to simple format for Frontend
    return slots.map(slot => ({
      time: slot.start_time.slice(0, 5), // HH:MM (轉回 time 給前端用)
      isBooked: slot.status !== 'available',
      status: slot.status
    }));
  }

  /**
   * Attempt to book a slot.
   */
  async attemptBooking(userId, date, time) {
    // 1. Find the slot in daily_slots
    const { data: slot, error: slotError } = await this.supabase
      .from('daily_slots')
      .select('id, status')
      .eq('target_date', date)      // ✅ 修正：改成 target_date
      .eq('start_time', time)       // ✅ 這裡用 start_time (正確)
      .single();

    if (slotError) {
        // 如果找不到，代表沒開放或該時段不存在
        throw new Error('Slot not found or not open for booking.');
    }

    if (slot.status !== 'available') {
        throw new Error('Slot is already booked or locked.');
    }

    // 2. Lock the slot (Optimistic locking)
    const { data: updated, error: updateError } = await this.supabase
        .from('daily_slots')
        .update({ status: 'locked' })
        .eq('id', slot.id)
        .eq('status', 'available')
        .select();

    if (updateError) throw updateError;

    if (!updated || updated.length === 0) {
        throw new Error('Slot was just taken by another user.');
    }

    return slot.id;
  }

  /**
   * Confirm booking (link appointment)
   */
  async confirmSlotBooking(slotId, appointmentId) {
      const { error } = await this.supabase
          .from('daily_slots')
          .update({ appointment_id: appointmentId, status: 'booked' })
          .eq('id', slotId);

      if (error) throw error;
  }
}

module.exports = InventoryService;
