package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.AddMedicationRequest;
import com.example.dosebuddy.model.Medication;
import com.example.dosebuddy.model.MedicationTime;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.IntakeLogRepository;
import com.example.dosebuddy.repository.MedicationRepository;
import com.example.dosebuddy.repository.MedicationTimeRepository;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.security.UserPrincipal;
import com.example.dosebuddy.service.ActivityService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;

@RestController
@RequestMapping("/api/medications")
@CrossOrigin("*")
public class MedicationController {

    private final UserRepository userRepo;
    private final MedicationRepository medRepo;
    private final MedicationTimeRepository timeRepo;
    private final IntakeLogRepository logRepo;
    private final ActivityService activityService;

    public MedicationController(UserRepository userRepo,
                                MedicationRepository medRepo,
                                MedicationTimeRepository timeRepo,
                                IntakeLogRepository logRepo,
                                ActivityService activityService) {
        this.userRepo = userRepo;
        this.medRepo = medRepo;
        this.timeRepo = timeRepo;
        this.logRepo = logRepo;
        this.activityService = activityService;
    }

    @PostMapping("/add")
    public ResponseEntity<?> addMedication(@RequestBody AddMedicationRequest req,
                                           @AuthenticationPrincipal UserPrincipal principal) {
        User user = userRepo.findById(principal.getUserId()).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }

        Medication med = new Medication();
        med.setUser(user);
        med.setName(req.getName());
        med.setDosage(req.getDosage());
        med.setInstructions(req.getInstructions());
        med.setStartDate(LocalDate.parse(req.getStartDate()));
        med.setEndDate(LocalDate.parse(req.getEndDate()));

        med = medRepo.save(med);

        List<MedicationTime> timeList = new ArrayList<>();
        if (req.getTimes() != null) {
            for (String t : req.getTimes()) {
                MedicationTime time = new MedicationTime();
                time.setMedication(med);
                time.setTimeOfDay(LocalTime.parse(t));
                timeList.add(timeRepo.save(time));
            }
        }

        med.setTimes(timeList);
        
        String activityMessage = String.format("Added new medication: %s (%s)", med.getName(), med.getDosage());
        activityService.logActivity(user, "MEDICINE_ADDED", activityMessage, "MEDICATION", med.getId());
        
        return ResponseEntity.ok("Medication added");
    }

    @GetMapping("/today/{userId}")
    public ResponseEntity<?> getToday(@PathVariable Long userId,
                                      @AuthenticationPrincipal UserPrincipal principal) {
        User user = userRepo.findById(userId).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("User not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate today = LocalDate.now();

        List<Medication> meds = medRepo.findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
                user, today, today
        );

        return ResponseEntity.ok(meds);
    }

    @GetMapping("/today-by-email/{email}")
    public ResponseEntity<?> getTodayByEmail(@PathVariable String email,
                                             @AuthenticationPrincipal UserPrincipal principal) {
        User user = userRepo.findByEmail(email.toLowerCase()).orElse(null);
        if (user == null) {
            return ResponseEntity.badRequest().body("Patient not found");
        }
        if (!canAccessUser(user, principal)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        LocalDate today = LocalDate.now();

        List<Medication> meds = medRepo.findByUserAndStartDateLessThanEqualAndEndDateGreaterThanEqual(
                user, today, today
        );

        return ResponseEntity.ok(meds);
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<?> deleteMedication(@PathVariable Long id,
                                              @AuthenticationPrincipal UserPrincipal principal) {
        Medication med = medRepo.findById(id).orElse(null);
        if (med == null) {
            return ResponseEntity.notFound().build();
        }
        if (med.getUser() == null || !med.getUser().getId().equals(principal.getUserId())) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).body("Access denied");
        }

        User user = med.getUser();
        String medName = med.getName();
        String medDosage = med.getDosage();

        try {

            logRepo.deleteByMedicationId(id);


            timeRepo.deleteByMedicationId(id);


            medRepo.deleteById(id);


            String activityMessage = String.format("Removed medication: %s (%s)", medName, medDosage);
            activityService.logActivity(user, "MEDICINE_DELETED", activityMessage, "MEDICATION", id);
            return ResponseEntity.noContent().build();
        } catch (Exception e) {
            e.printStackTrace();
            return ResponseEntity
                    .status(500)
                    .body("Error deleting medicine: " + e.getMessage());
        }
    }

    private boolean canAccessUser(User target, UserPrincipal principal) {
        if (target == null || principal == null) return false;
        if (target.getId().equals(principal.getUserId())) return true;
        User authUser = principal.getUser();
        return "CAREGIVER".equalsIgnoreCase(authUser.getRole())
                && authUser.getPatientEmail() != null
                && authUser.getPatientEmail().equalsIgnoreCase(target.getEmail());
    }
}
