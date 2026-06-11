package com.example.dosebuddy.service;

import com.example.dosebuddy.model.IntakeLog;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.MedicationTime;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ScheduledDoseServiceTest {

    @Mock MedicationRepository medicationRepository;
    @Mock IntakeLogRepository intakeLogRepository;

    private ScheduledDoseService service;
    private User user;
    private Medication medication;

    @BeforeEach
    void setUp() {
        service = new ScheduledDoseService(medicationRepository, intakeLogRepository);
        user = new User();
        user.setId(1L);

        medication = new Medication();
        medication.setId(10L);
        medication.setUser(user);
        medication.setName("Test Med");
        medication.setDosage("10 mg");
    }

    @Test
    void derivesMissedAndPendingFromScheduleAndExcludesPendingFromAdherence() {
        LocalDate day = LocalDate.of(2026, 6, 11);
        medication.setStartDate(day);
        medication.setEndDate(day);
        medication.setTimes(List.of(time(8, 0), time(12, 0), time(20, 0)));

        IntakeLog taken = log(day, 8, 0, "TAKEN");
        when(medicationRepository.findScheduledInRange(user, day, day)).thenReturn(List.of(medication));
        when(intakeLogRepository.findLogsWithMedication(user, day, day))
                .thenReturn(List.of(taken));

        ScheduledDoseService.Summary result = service.summarize(
                user, day, day, LocalDateTime.of(day, LocalTime.of(15, 0)));

        assertThat(result.total()).isEqualTo(3);
        assertThat(result.taken()).isEqualTo(1);
        assertThat(result.missed()).isEqualTo(1);
        assertThat(result.pending()).isEqualTo(1);
        assertThat(result.adherencePercentage()).isEqualTo(50.0);
        assertThat(result.perfectDays()).isEmpty();
    }

    @Test
    void perfectDayRequiresEveryScheduledDoseTakenAndDeduplicatesLogs() {
        LocalDate day = LocalDate.of(2026, 6, 10);
        medication.setStartDate(day);
        medication.setEndDate(day);
        medication.setTimes(List.of(time(8, 0), time(20, 0)));

        IntakeLog oldMissed = log(day, 8, 0, "MISSED");
        IntakeLog correctedTaken = log(day, 8, 0, "TAKEN");
        IntakeLog eveningTaken = log(day, 20, 0, "TAKEN");
        when(medicationRepository.findScheduledInRange(user, day, day)).thenReturn(List.of(medication));
        when(intakeLogRepository.findLogsWithMedication(user, day, day))
                .thenReturn(List.of(oldMissed, correctedTaken, eveningTaken));

        ScheduledDoseService.Summary result = service.summarize(
                user, day, day, LocalDateTime.of(2026, 6, 11, 10, 0));

        assertThat(result.total()).isEqualTo(2);
        assertThat(result.taken()).isEqualTo(2);
        assertThat(result.missed()).isZero();
        assertThat(result.perfectDays()).containsExactly(day);
    }

    private MedicationTime time(int hour, int minute) {
        MedicationTime value = new MedicationTime();
        value.setMedication(medication);
        value.setTimeOfDay(LocalTime.of(hour, minute));
        return value;
    }

    private IntakeLog log(LocalDate day, int hour, int minute, String status) {
        IntakeLog value = new IntakeLog();
        value.setMarker(user);
        value.setMedication(medication);
        value.setDate(day);
        value.setTime(LocalTime.of(hour, minute));
        value.setStatus(status);
        return value;
    }
}
