package com.example.dosebuddy.controller;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import com.example.dosebuddy.repository.MedicationTimeRepository;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.ActivityService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * Regression tests for the dashboard "today" endpoints.
 *
 * These guard the bug where a medicine was saved successfully but did not show
 * on the dashboard: the controller used to ignore the client-supplied date and
 * hardcode {@code LocalDate.now()}, so a medicine saved for the browser-local
 * day could fall outside the server-local query near a day/timezone boundary.
 *
 * A FIXED request date (2026-06-11) is used so the assertions are independent
 * of the machine's current date.
 */
class MedicationControllerTest {

    private static final LocalDate REQUESTED_DATE = LocalDate.parse("2026-06-11");

    private UserRepository userRepo;
    private MedicationRepository medRepo;
    private MedicationTimeRepository timeRepo;
    private IntakeLogRepository logRepo;
    private ActivityService activityService;

    private MedicationController controller;

    @BeforeEach
    void setUp() {
        userRepo = mock(UserRepository.class);
        medRepo = mock(MedicationRepository.class);
        timeRepo = mock(MedicationTimeRepository.class);
        logRepo = mock(IntakeLogRepository.class);
        // ActivityService is not exercised by the read-only "today" endpoints
        // under test, and the Mockito inline mock-maker cannot instrument this
        // concrete class on newer JDKs, so pass a null collaborator instead.
        activityService = null;
        controller = new MedicationController(userRepo, medRepo, timeRepo, logRepo, activityService);
    }

    private User patient(Long id, String email) {
        User u = new User();
        u.setId(id);
        u.setEmail(email);
        u.setRole("PATIENT");
        return u;
    }

    private User caregiver(Long id, String email, String patientEmail) {
        User u = new User();
        u.setId(id);
        u.setEmail(email);
        u.setRole("CAREGIVER");
        u.setPatientEmail(patientEmail);
        return u;
    }

    @SuppressWarnings("unchecked")
    @Test
    void getToday_returnsMedicationActiveOnRequestedDate_andUsesRequestedDateAsBothBounds() {
        User user = patient(1L, "patient@example.com");
        when(userRepo.findById(1L)).thenReturn(Optional.of(user));

        Medication med = new Medication();
        med.setId(10L);
        med.setName("Aspirin");
        when(medRepo.findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
                eq(user), eq(REQUESTED_DATE), eq(REQUESTED_DATE)))
                .thenReturn(List.of(med));

        ResponseEntity<?> response =
                controller.getToday(1L, "2026-06-11", new UserPrincipal(user));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<Medication>) response.getBody()).containsExactly(med);

        // The requested date (not LocalDate.now()) must be used for BOTH bounds.
        ArgumentCaptor<LocalDate> startCap = ArgumentCaptor.forClass(LocalDate.class);
        ArgumentCaptor<LocalDate> endCap = ArgumentCaptor.forClass(LocalDate.class);
        verify(medRepo).findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
                eq(user), startCap.capture(), endCap.capture());
        assertThat(startCap.getValue()).isEqualTo(REQUESTED_DATE);
        assertThat(endCap.getValue()).isEqualTo(REQUESTED_DATE);
    }

    @Test
    void getToday_unknownUser_returns400() {
        when(userRepo.findById(99L)).thenReturn(Optional.empty());

        ResponseEntity<?> response =
                controller.getToday(99L, "2026-06-11", new UserPrincipal(patient(1L, "x@example.com")));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).isEqualTo("User not found");
        verifyNoInteractions(medRepo);
    }

    @Test
    void getToday_mismatchedUser_returns403() {
        User target = patient(1L, "patient@example.com");
        when(userRepo.findById(1L)).thenReturn(Optional.of(target));

        User otherPatient = patient(2L, "other@example.com");

        ResponseEntity<?> response =
                controller.getToday(1L, "2026-06-11", new UserPrincipal(otherPatient));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(response.getBody()).isEqualTo("Access denied");
        verifyNoInteractions(medRepo);
    }

    @Test
    void getToday_invalidDate_returns400_withoutServerDateFallback() {
        User user = patient(1L, "patient@example.com");
        when(userRepo.findById(1L)).thenReturn(Optional.of(user));

        ResponseEntity<?> response =
                controller.getToday(1L, "11-06-2026", new UserPrincipal(user));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).isEqualTo("Invalid date; use YYYY-MM-DD");
        // Must NOT fall back to LocalDate.now() and query anyway.
        verifyNoInteractions(medRepo);
    }

    @SuppressWarnings("unchecked")
    @Test
    void getTodayByEmail_linkedCaregiver_canRetrieveConfiguredPatient() {
        User patient = patient(1L, "patient@example.com");
        when(userRepo.findByEmail("patient@example.com")).thenReturn(Optional.of(patient));

        Medication med = new Medication();
        med.setId(20L);
        when(medRepo.findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
                eq(patient), eq(REQUESTED_DATE), eq(REQUESTED_DATE)))
                .thenReturn(List.of(med));

        User caregiver = caregiver(5L, "caregiver@example.com", "patient@example.com");

        ResponseEntity<?> response = controller.getTodayByEmail(
                "patient@example.com", "2026-06-11", new UserPrincipal(caregiver));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<Medication>) response.getBody()).containsExactly(med);
    }

    @Test
    void getTodayByEmail_unknownPatient_returns400() {
        when(userRepo.findByEmail("missing@example.com")).thenReturn(Optional.empty());

        ResponseEntity<?> response = controller.getTodayByEmail(
                "missing@example.com", "2026-06-11",
                new UserPrincipal(caregiver(5L, "caregiver@example.com", "missing@example.com")));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).isEqualTo("Patient not found");
        verifyNoInteractions(medRepo);
    }

    @Test
    void getTodayByEmail_invalidDate_returns400() {
        User patient = patient(1L, "patient@example.com");
        when(userRepo.findByEmail("patient@example.com")).thenReturn(Optional.of(patient));

        User caregiver = caregiver(5L, "caregiver@example.com", "patient@example.com");

        ResponseEntity<?> response = controller.getTodayByEmail(
                "patient@example.com", "not-a-date", new UserPrincipal(caregiver));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).isEqualTo("Invalid date; use YYYY-MM-DD");
        verifyNoInteractions(medRepo);
    }
}
