package com.example.dosebuddy.service;

import com.example.dosebuddy.dto.VitalRecordDto;
import com.example.dosebuddy.dto.VitalRecordRequest;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.model.VitalRecord;
import com.example.dosebuddy.repository.UserRepository;
import com.example.dosebuddy.repository.VitalRecordRepository;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

@Service
public class VitalService {

    private final VitalRecordRepository vitalRepo;
    private final UserRepository userRepo;
    private final ActivityService activityService;

    public VitalService(VitalRecordRepository vitalRepo,
                        UserRepository userRepo,
                        ActivityService activityService) {
        this.vitalRepo = vitalRepo;
        this.userRepo = userRepo;
        this.activityService = activityService;
    }

    public VitalRecordDto saveVital(VitalRecordRequest req) {
        validateRequest(req);

        VitalRecord record = new VitalRecord(
                req.getUserId(),
                req.getBpSystolic(),
                req.getBpDiastolic(),
                req.getBloodSugar(),
                req.getWeight(),
                req.getHeartRate(),
                req.getTemperature(),
                req.getNotes()
        );

        record = vitalRepo.save(record);

        User user = userRepo.findById(req.getUserId()).orElse(null);
        if (user != null) {
            String msg = buildActivityMessage(record);
            activityService.logActivity(user, "VITALS_LOGGED", msg, "VITAL_RECORD", record.getId());
        }

        return toDto(record);
    }

    public Optional<VitalRecordDto> getLatest(Long userId) {
        return vitalRepo.findLatestByUserId(userId).map(this::toDto);
    }

    public List<VitalRecordDto> getHistory(Long userId) {
        return vitalRepo.findByUserIdOrderByRecordedAtDesc(userId)
                .stream().map(this::toDto).collect(Collectors.toList());
    }

    public List<VitalRecordDto> getRecent(Long userId, int limit) {
        return vitalRepo.findByUserIdOrderByRecordedAtDesc(userId)
                .stream().limit(Math.max(1, limit))
                .map(this::toDto).collect(Collectors.toList());
    }

    public List<VitalRecordDto> getTrend(Long userId, String period) {
        LocalDateTime since;
        switch (period.toLowerCase()) {
            case "week":
                since = LocalDateTime.now().minusDays(7);
                break;
            case "month":
                since = LocalDateTime.now().minusDays(30);
                break;
            default:
                since = LocalDateTime.of(2000, 1, 1, 0, 0);
                break;
        }
        return vitalRepo.findByUserIdAndRecordedAtAfterOrderByRecordedAtAsc(userId, since)
                .stream().map(this::toDto).collect(Collectors.toList());
    }

    public boolean deleteVital(Long id) {
        if (!vitalRepo.existsById(id)) return false;
        vitalRepo.deleteById(id);
        return true;
    }


    private void validateRequest(VitalRecordRequest req) {
        if (req.getUserId() == null) {
            throw new IllegalArgumentException("User ID is required");
        }
        boolean hasAny = req.getBpSystolic() != null || req.getBpDiastolic() != null
                || req.getBloodSugar() != null || req.getWeight() != null
                || req.getHeartRate() != null || req.getTemperature() != null;
        if (!hasAny) {
            throw new IllegalArgumentException("At least one vital measurement is required");
        }
        if (req.getBpSystolic() != null && (req.getBpSystolic() < 50 || req.getBpSystolic() > 300)) {
            throw new IllegalArgumentException("Systolic BP must be between 50 and 300 mmHg");
        }
        if (req.getBpDiastolic() != null && (req.getBpDiastolic() < 30 || req.getBpDiastolic() > 200)) {
            throw new IllegalArgumentException("Diastolic BP must be between 30 and 200 mmHg");
        }
        if (req.getBloodSugar() != null && (req.getBloodSugar() < 20 || req.getBloodSugar() > 600)) {
            throw new IllegalArgumentException("Blood sugar must be between 20 and 600 mg/dL");
        }
        if (req.getWeight() != null && (req.getWeight() < 10 || req.getWeight() > 500)) {
            throw new IllegalArgumentException("Weight must be between 10 and 500 kg");
        }
        if (req.getHeartRate() != null && (req.getHeartRate() < 20 || req.getHeartRate() > 300)) {
            throw new IllegalArgumentException("Heart rate must be between 20 and 300 bpm");
        }
        if (req.getTemperature() != null && (req.getTemperature() < 30 || req.getTemperature() > 45)) {
            throw new IllegalArgumentException("Temperature must be between 30 and 45 C");
        }
    }

    private VitalRecordDto toDto(VitalRecord r) {
        VitalRecordDto dto = new VitalRecordDto();
        dto.setId(r.getId());
        dto.setUserId(r.getUserId());
        dto.setBpSystolic(r.getBpSystolic());
        dto.setBpDiastolic(r.getBpDiastolic());
        dto.setBloodSugar(r.getBloodSugar());
        dto.setWeight(r.getWeight());
        dto.setHeartRate(r.getHeartRate());
        dto.setTemperature(r.getTemperature());
        dto.setNotes(r.getNotes());
        dto.setRecordedAt(r.getRecordedAt());
        dto.setBpStatus(classifyBp(r.getBpSystolic(), r.getBpDiastolic()));
        dto.setSugarStatus(classifySugar(r.getBloodSugar()));
        dto.setHeartRateStatus(classifyHeartRate(r.getHeartRate()));
        dto.setTempStatus(classifyTemp(r.getTemperature()));
        return dto;
    }

    private String classifyBp(Integer sys, Integer dia) {
        if (sys == null || dia == null) return null;
        if (sys < 90 || dia < 60)       return "LOW";
        if (sys < 120 && dia < 80)      return "NORMAL";
        if (sys < 130 && dia < 80)      return "ELEVATED";
        if (sys < 140 || dia < 90)      return "HIGH_STAGE1";
        return "HIGH_STAGE2";
    }

    private String classifySugar(Double sugar) {
        if (sugar == null) return null;
        if (sugar < 70)    return "LOW";
        if (sugar <= 140)  return "NORMAL";
        if (sugar <= 200)  return "ELEVATED";
        return "HIGH";
    }

    private String classifyHeartRate(Integer hr) {
        if (hr == null)  return null;
        if (hr < 60)     return "LOW";
        if (hr <= 100)   return "NORMAL";
        return "HIGH";
    }

    private String classifyTemp(Double temp) {
        if (temp == null)  return null;
        if (temp < 36.0)   return "HYPOTHERMIA";
        if (temp <= 37.5)  return "NORMAL";
        if (temp <= 38.5)  return "LOW_FEVER";
        return "FEVER";
    }

    private String buildActivityMessage(VitalRecord r) {
        StringBuilder sb = new StringBuilder("Vitals logged:");
        if (r.getBpSystolic() != null && r.getBpDiastolic() != null) {
            sb.append(" BP ").append(r.getBpSystolic()).append("/").append(r.getBpDiastolic()).append(" mmHg,");
        }
        if (r.getBloodSugar() != null) {
            sb.append(" Sugar ").append(r.getBloodSugar()).append(" mg/dL,");
        }
        if (r.getWeight() != null) {
            sb.append(" Weight ").append(r.getWeight()).append(" kg,");
        }
        if (r.getHeartRate() != null) {
            sb.append(" HR ").append(r.getHeartRate()).append(" bpm,");
        }
        if (r.getTemperature() != null) {
            sb.append(" Temp ").append(r.getTemperature()).append(" C,");
        }
        String msg = sb.toString();
        if (msg.endsWith(",")) msg = msg.substring(0, msg.length() - 1);
        return msg;
    }
}
