package com.example.dosebuddy.service;

import com.example.dosebuddy.dto.BmiCalculationRequest;
import com.example.dosebuddy.dto.BmiResponseDto;
import com.example.dosebuddy.model.BmiRecord;
import com.example.dosebuddy.model.User;
import com.example.dosebuddy.repository.BmiRecordRepository;
import com.example.dosebuddy.repository.UserRepository;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

@Service
public class BmiService {

    private final BmiRecordRepository bmiRecordRepository;
    private final UserRepository userRepository;
    private final ActivityService activityService;

    public BmiService(BmiRecordRepository bmiRecordRepository,
                      UserRepository userRepository,
                      ActivityService activityService) {
        this.bmiRecordRepository = bmiRecordRepository;
        this.userRepository = userRepository;
        this.activityService = activityService;
    }

    public BmiResponseDto calculateAndSaveBmi(BmiCalculationRequest request) {
        validateInput(request);

        double heightInMeters = request.getHeight() / 100.0;
        double bmiValue = request.getWeight() / (heightInMeters * heightInMeters);
        
        BigDecimal bd = new BigDecimal(bmiValue).setScale(1, RoundingMode.HALF_UP);
        bmiValue = bd.doubleValue();

        String category = determineBmiCategory(bmiValue);
        
        BmiRecord record = new BmiRecord(
            request.getUserId(),
            request.getHeight(),
            request.getWeight(),
            bmiValue,
            category
        );
        record = bmiRecordRepository.save(record);

        User user = userRepository.findById(request.getUserId()).orElse(null);
        if (user != null) {
            String activityMessage = String.format("BMI calculated: %.1f (%s)", bmiValue, category);
            activityService.logActivity(user, "BMI_CALCULATED", activityMessage, "BMI_RECORD", record.getId());
        }

        return buildBmiResponse(record);
    }

    public Optional<BmiResponseDto> getLatestBmi(Long userId) {
        Optional<BmiRecord> record = bmiRecordRepository.findLatestByUserId(userId);
        return record.map(this::buildBmiResponse);
    }

    public List<BmiResponseDto> getBmiHistory(Long userId) {
        List<BmiRecord> records = bmiRecordRepository.findByUserIdOrderByCreatedAtDesc(userId);
        return records.stream()
                .map(this::buildBmiResponse)
                .collect(Collectors.toList());
    }

    public List<BmiResponseDto> getRecentBmiHistory(Long userId, int limit) {
        List<BmiRecord> records = bmiRecordRepository.findByUserIdOrderByCreatedAtDesc(userId);
        return records.stream()
                .limit(Math.max(1, limit))
                .map(this::buildBmiResponse)
                .collect(Collectors.toList());
    }

    private void validateInput(BmiCalculationRequest request) {
        if (request.getUserId() == null) {
            throw new IllegalArgumentException("User ID is required");
        }
        if (request.getHeight() == null || request.getHeight() <= 0) {
            throw new IllegalArgumentException("Valid height is required");
        }
        if (request.getWeight() == null || request.getWeight() <= 0) {
            throw new IllegalArgumentException("Valid weight is required");
        }
        if (request.getHeight() < 50 || request.getHeight() > 300) {
            throw new IllegalArgumentException("Height must be between 50 and 300 cm");
        }
        if (request.getWeight() < 20 || request.getWeight() > 500) {
            throw new IllegalArgumentException("Weight must be between 20 and 500 kg");
        }
    }

    private String determineBmiCategory(double bmi) {
        if (bmi < 18.5) {
            return "UNDERWEIGHT";
        } else if (bmi < 25.0) {
            return "NORMAL";
        } else if (bmi < 30.0) {
            return "OVERWEIGHT";
        } else {
            return "OBESE";
        }
    }

    private BmiResponseDto buildBmiResponse(BmiRecord record) {
        String healthStatus = getHealthStatus(record.getBmiCategory());
        String statusColor = getStatusColor(record.getBmiCategory());
        List<String> healthSuggestions = getHealthSuggestions(record.getBmiCategory());
        List<String> dietRecommendations = getDietRecommendations(record.getBmiCategory());

        return new BmiResponseDto(
            record.getId(),
            record.getHeight(),
            record.getWeight(),
            record.getBmiValue(),
            record.getBmiCategory(),
            healthStatus,
            statusColor,
            healthSuggestions,
            dietRecommendations,
            record.getCreatedAt()
        );
    }

    private String getHealthStatus(String category) {
        switch (category) {
            case "UNDERWEIGHT":
                return "Below Healthy Weight";
            case "NORMAL":
                return "Healthy Weight";
            case "OVERWEIGHT":
                return "Above Healthy Weight";
            case "OBESE":
                return "Obesity Range";
            default:
                return "Unknown";
        }
    }

    private String getStatusColor(String category) {
        switch (category) {
            case "UNDERWEIGHT":
                return "#3b82f6"; // blue
            case "NORMAL":
                return "#22c55e"; // green
            case "OVERWEIGHT":
                return "#f59e0b"; // orange
            case "OBESE":
                return "#ef4444"; // red
            default:
                return "#6b7280"; // gray
        }
    }

    private List<String> getHealthSuggestions(String category) {
        List<String> suggestions = new ArrayList<>();
        
        switch (category) {
            case "UNDERWEIGHT":
                suggestions.add("Focus on nutrient-dense foods to gain weight healthily");
                suggestions.add("Include protein-rich foods in every meal");
                suggestions.add("Consider strength training exercises to build muscle mass");
                suggestions.add("Eat more frequently with healthy snacks between meals");
                suggestions.add("Consult a nutritionist for a personalized meal plan");
                break;
                
            case "NORMAL":
                suggestions.add("Maintain your current healthy lifestyle");
                suggestions.add("Continue balanced nutrition and regular exercise");
                suggestions.add("Stay hydrated with 8-10 glasses of water daily");
                suggestions.add("Get adequate sleep (7-9 hours) for optimal health");
                suggestions.add("Regular health check-ups to monitor your wellness");
                break;
                
            case "OVERWEIGHT":
                suggestions.add("Gradually increase physical activity to 150 minutes per week");
                suggestions.add("Focus on portion control and mindful eating");
                suggestions.add("Reduce intake of processed and high-calorie foods");
                suggestions.add("Include more vegetables and whole grains in your diet");
                suggestions.add("Consider consulting a healthcare professional for guidance");
                break;
                
            case "OBESE":
                suggestions.add("Consult a healthcare professional for a comprehensive health plan");
                suggestions.add("Start with small, sustainable lifestyle changes");
                suggestions.add("Focus on gradual weight reduction (0.5-1 kg per week)");
                suggestions.add("Consider working with a registered dietitian");
                suggestions.add("Regular monitoring of blood pressure and blood sugar levels");
                break;
        }
        
        return suggestions;
    }

    private List<String> getDietRecommendations(String category) {
        List<String> recommendations = new ArrayList<>();
        
        switch (category) {
            case "UNDERWEIGHT":
                recommendations.add("Increase calorie intake with healthy fats (nuts, avocados, olive oil)");
                recommendations.add("Add protein shakes or smoothies between meals");
                recommendations.add("Include whole grains, lean meats, and dairy products");
                recommendations.add("Eat calorie-dense foods like nut butters and dried fruits");
                recommendations.add("Don't skip meals - aim for 5-6 smaller meals daily");
                break;
                
            case "NORMAL":
                recommendations.add("Continue eating a variety of colorful fruits and vegetables");
                recommendations.add("Choose whole grains over refined carbohydrates");
                recommendations.add("Include lean proteins (fish, chicken, legumes)");
                recommendations.add("Limit added sugars and saturated fats");
                recommendations.add("Practice mindful eating and listen to hunger cues");
                break;
                
            case "OVERWEIGHT":
                recommendations.add("Reduce portion sizes gradually");
                recommendations.add("Fill half your plate with vegetables at each meal");
                recommendations.add("Choose lean proteins and limit red meat");
                recommendations.add("Avoid sugary drinks - opt for water or unsweetened beverages");
                recommendations.add("Limit eating out and prepare more meals at home");
                break;
                
            case "OBESE":
                recommendations.add("Create a structured meal plan with professional guidance");
                recommendations.add("Eliminate processed foods and fast food");
                recommendations.add("Focus on high-fiber foods to increase satiety");
                recommendations.add("Practice meal prepping to avoid unhealthy choices");
                recommendations.add("Keep a food diary to track eating patterns");
                break;
        }
        
        return recommendations;
    }
}
