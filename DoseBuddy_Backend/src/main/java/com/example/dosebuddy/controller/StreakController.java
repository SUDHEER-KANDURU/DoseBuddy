package com.example.dosebuddy.controller;

import com.example.dosebuddy.dto.StreakDto;
import com.example.dosebuddy.service.StreakService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/streaks")
@CrossOrigin("*")
public class StreakController {

    private final StreakService streakService;

    public StreakController(StreakService streakService) {
        this.streakService = streakService;
    }


    @GetMapping("/{userId}")
    public ResponseEntity<StreakDto> getStreak(@PathVariable Long userId) {
        StreakDto dto = streakService.getStreak(userId);
        return ResponseEntity.ok(dto);
    }

    @PostMapping("/recalculate/{userId}")
    public ResponseEntity<StreakDto> recalculate(@PathVariable Long userId) {
        StreakDto dto = streakService.recalculate(userId);
        return ResponseEntity.ok(dto);
    }
}
