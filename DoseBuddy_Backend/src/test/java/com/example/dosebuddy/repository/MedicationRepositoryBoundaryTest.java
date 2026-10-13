package com.example.dosebuddy.repository;

import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.User;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.test.context.ActiveProfiles;

import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Verifies inclusive start/end boundary semantics of the dashboard query
 * against a real (H2) database, using a fixed date (2026-06-11) so results do
 * not depend on the machine's current date.
 */
@DataJpaTest
@ActiveProfiles("test")
class MedicationRepositoryBoundaryTest {

    private static final LocalDate TARGET = LocalDate.parse("2026-06-11");

    @Autowired
    private MedicationRepository medRepo;

    @Autowired
    private UserRepository userRepo;

    private User user;

    @BeforeEach
    void setUp() {
        user = new User();
        user.setName("Pat");
        user.setEmail("pat@example.com");
        user.setPasswordHash("x");
        user.setRole("PATIENT");
        user = userRepo.save(user);
    }

    private void saveMed(String name, LocalDate start, LocalDate end) {
        Medication m = new Medication();
        m.setUser(user);
        m.setName(name);
        m.setDosage("1 pill");
        m.setStartDate(start);
        m.setEndDate(end);
        medRepo.save(m);
    }

    private List<Medication> queryTarget() {
        return medRepo.findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(user, TARGET, TARGET);
    }

    @Test
    void medicineActiveOnTargetDate_isReturned() {
        saveMed("spanning", TARGET.minusDays(3), TARGET.plusDays(3));
        assertThat(queryTarget()).extracting(Medication::getName).containsExactly("spanning");
    }

    @Test
    void startDateEqualToTarget_isInclusive() {
        saveMed("startsOnTarget", TARGET, TARGET.plusDays(5));
        assertThat(queryTarget()).extracting(Medication::getName).containsExactly("startsOnTarget");
    }

    @Test
    void endDateEqualToTarget_isInclusive() {
        saveMed("endsOnTarget", TARGET.minusDays(5), TARGET);
        assertThat(queryTarget()).extracting(Medication::getName).containsExactly("endsOnTarget");
    }

    @Test
    void startDateDayAfterTarget_isExcluded() {
        saveMed("startsTomorrow", TARGET.plusDays(1), TARGET.plusDays(5));
        assertThat(queryTarget()).isEmpty();
    }

    @Test
    void endDateDayBeforeTarget_isExcluded() {
        saveMed("endedYesterday", TARGET.minusDays(5), TARGET.minusDays(1));
        assertThat(queryTarget()).isEmpty();
    }
}
